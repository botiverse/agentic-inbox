import { describe, it, expect } from "vitest";
import { app, receiveEmail } from "./index";

// These hit the mailbox-create validation path, which returns before any
// Cloudflare binding (R2/DO) is touched — so they run in plain Node with an
// empty env. Regression cover for: invalid input must return a clean 400, not
// crash as a 500 (unhandled ZodError).
async function postMailbox(body: unknown) {
	return app.request(
		"/api/v1/mailboxes",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		},
		{} as never,
	);
}

describe("POST /api/v1/mailboxes — body validation", () => {
	it("returns 400 (not 500) for a non-email `email` (bad shape, pre-auth)", async () => {
		const res = await postMailbox({ email: "notanemail", name: "x" });
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string; code: string };
		expect(body.code).toBe("BAD_REQUEST");
		expect(body.error).toMatch(/<local-part>@<domain>/);
	});

	it("returns 400 with INVALID_LOCALPART for a non-ASCII / CJK local-part (EAI not yet supported)", async () => {
		const res = await postMailbox({ email: "测试@mail.build", name: "x" });
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string; code: string };
		expect(body.code).toBe("INVALID_LOCALPART");
		// Unauthenticated caller has no handle → no derived-namespace hint, but the
		// ASCII rule is still stated clearly (the authenticated CJK path adds the hint).
		expect(body.error).toMatch(/ASCII/);
	});

	it("returns 400 (not 500) for a missing `name`", async () => {
		const res = await postMailbox({ email: "ok@mail.build" });
		expect(res.status).toBe(400);
	});

	it("returns 400 (not 500) for malformed JSON", async () => {
		const res = await postMailbox("{not valid json");
		expect(res.status).toBe(400);
	});
});

// --- Inbound delivery: plus-addressing + unknown-recipient reject -------------
// These drive the REAL receiveEmail path (MIME parse → recipient resolution →
// mailbox lookup → reject-or-deliver) with a fake message + env, because the
// setReject wiring is precisely the kind of thing that silently regresses.

function rawEmail(to: string): { stream: ReadableStream; size: number } {
	const text = [
		"From: sender@example.com",
		`To: ${to}`,
		"Subject: hello",
		"",
		"body text",
		"",
	].join("\r\n");
	const bytes = new TextEncoder().encode(text);
	return {
		stream: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
		size: bytes.byteLength,
	};
}

/** env whose mailbox store contains exactly `existing`; records what was looked
 * up and which mailbox instance (Durable Object name) delivery was routed to. */
function envWithMailboxes(existing: string[]) {
	const heads: string[] = [];
	const doNames: string[] = [];
	const stored: Array<{ recipient?: string }> = [];
	const env = {
		DOMAINS: "mail.build",
		EMAIL_ADDRESSES: [],
		BUCKET: {
			head: async (key: string) => {
				heads.push(key);
				return existing.some((e) => key === `mailboxes/${e}.json`) ? {} : null;
			},
			get: async () => null,
			put: async () => {},
		},
		MAILBOX: {
			idFromName: (n: string) => { doNames.push(n); return n; },
			get: () => ({
				createEmail: async (_folder: string, row: { recipient?: string }) => { stored.push(row); },
				findThreadBySubject: async () => null,
			}),
		},
		EMAIL_AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("") }) },
	} as never;
	return { heads, doNames, stored, env };
}

async function deliver(to: string, existing: string[]) {
	const { stream, size } = rawEmail(to);
	const rejects: string[] = [];
	const { heads, doNames, stored, env } = envWithMailboxes(existing);
	const event = { raw: stream, rawSize: size, setReject: (r: string) => rejects.push(r) };
	await receiveEmail(event, env, { waitUntil() {} } as never);
	return { rejects, heads, doNames, stored };
}

describe("inbound: plus-addressing delivers to the base mailbox (AX: artin)", () => {
	it("looks up the BASE mailbox for a +tag recipient", async () => {
		const { rejects, heads, doNames, stored } = await deliver("artin+staging-smoke@mail.build", ["artin@mail.build"]);
		// existence check + mailbox instance both resolve to the BASE address
		expect(heads).toContain("mailboxes/artin@mail.build.json");
		expect(doNames).toContain("artin@mail.build");
		expect(rejects).toEqual([]);
		// ...but the stored recipient keeps the FULL tagged address, so the tag
		// survives and stays filterable — that is the point of plus-addressing.
		expect(stored[0].recipient).toBe("artin+staging-smoke@mail.build");
	});

	it("still delivers a plain address unchanged", async () => {
		const { rejects, heads, doNames, stored } = await deliver("artin@mail.build", ["artin@mail.build"]);
		expect(heads).toContain("mailboxes/artin@mail.build.json");
		expect(doNames).toContain("artin@mail.build");
		expect(rejects).toEqual([]);
		expect(stored[0].recipient).toBe("artin@mail.build");
	});
});

describe("inbound: unknown recipient is REJECTED in-session, never silently dropped", () => {
	it("rejects when the base mailbox does not exist", async () => {
		const { rejects } = await deliver("nobody@mail.build", ["artin@mail.build"]);
		expect(rejects).toHaveLength(1);
		expect(rejects[0]).toMatch(/no such mailbox/i);
		expect(rejects[0]).toContain("nobody@mail.build");
	});

	it("rejects a +tag whose BASE mailbox does not exist (tag is not a mailbox)", async () => {
		const { rejects } = await deliver("ghost+tag@mail.build", ["artin@mail.build"]);
		expect(rejects).toHaveLength(1);
		// names the base address, not the tagged one
		expect(rejects[0]).toContain("ghost@mail.build");
	});

	it("rejects a recipient outside our domains", async () => {
		const { rejects } = await deliver("someone@elsewhere.example", ["artin@mail.build"]);
		expect(rejects).toHaveLength(1);
		expect(rejects[0]).toMatch(/no such recipient/i);
	});

	it("never generates a bounce email — rejection is in-session only (no backscatter)", async () => {
		// A send path would need BUCKET.put / an email binding; the reject path must
		// touch neither. env here has no send capability at all, so any attempt to
		// mail a bounce would throw rather than pass.
		const { rejects } = await deliver("nobody@mail.build", []);
		expect(rejects).toHaveLength(1);
	});
});
