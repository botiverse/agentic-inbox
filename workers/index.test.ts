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
	const sent: unknown[] = [];
	const env = {
		// Production's `env.EMAIL` binding is UNRESTRICTED (it can mail any address —
		// it has to, for replies/forwards). So nothing at the platform layer stops a
		// send from the INBOUND path; only this spy does. (infra review: Gogo.)
		EMAIL: { send: async (m: unknown) => { sent.push(m); } },
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
	return { heads, doNames, stored, sent, env };
}

async function deliver(to: string, existing: string[]) {
	const { stream, size } = rawEmail(to);
	const rejects: string[] = [];
	const { heads, doNames, stored, sent, env } = envWithMailboxes(existing);
	const event = { raw: stream, rawSize: size, setReject: (r: string) => rejects.push(r) };
	await receiveEmail(event, env, { waitUntil() {} } as never);
	return { rejects, heads, doNames, stored, sent };
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
		const { rejects, sent } = await deliver("nobody@mail.build", []);
		expect(rejects).toHaveLength(1);
		expect(sent).toHaveLength(0);
	});
});

describe("inbound path sends ZERO mail (backscatter guard — infra review: Gogo)", () => {
	// This is the structural teeth behind "the receive path never sends". The
	// platform gives us nothing here: `env.EMAIL` is unrestricted and MUST stay
	// that way (replies/forwards need to reach any address), so an allow-list
	// cannot be the control point. Without this test the property survives only as
	// long as every future editor reads the backscatter reasoning in the comments.
	// If someone adds a send to the receive path, these go red immediately.
	it("sends nothing when delivering a normal message", async () => {
		const { sent } = await deliver("artin@mail.build", ["artin@mail.build"]);
		expect(sent).toHaveLength(0);
	});

	it("sends nothing when delivering to a +tag address", async () => {
		const { sent } = await deliver("artin+promo@mail.build", ["artin@mail.build"]);
		expect(sent).toHaveLength(0);
	});

	it("sends nothing when REJECTING an unknown mailbox (the backscatter case)", async () => {
		// The dangerous one: spam forges the From, so mailing a "bounce" here would
		// hit an innocent third party and get mail.build blacklisted.
		const { sent } = await deliver("nobody@mail.build", ["artin@mail.build"]);
		expect(sent).toHaveLength(0);
	});

	it("sends nothing when REJECTING an off-domain recipient", async () => {
		const { sent } = await deliver("someone@elsewhere.example", ["artin@mail.build"]);
		expect(sent).toHaveLength(0);
	});
});

// --- Internal send: plus-addressed recipients must resolve to the base mailbox --
// Found by a pre-deploy BASELINE probe: sending to `postel+baseline@mail.build`
// returned 404 "Recipient mailbox does not exist". The inbound SMTP fix did not
// cover this path, and internal send is the ONLY send v0 supports — so `+` would
// have looked broken exactly where agents use it most.

describe("internal send resolves a +tag recipient to its base mailbox", () => {
	async function sendTo(to: string, existing: string[]) {
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
				// requireMailbox GETs the sender's mailbox to read its owner
				get: async (key: string) =>
					existing.some((e) => key === `mailboxes/${e}.json`)
						? { json: async () => ({ owner: "test" }) }
						: null,
			},
			MAILBOX: {
				idFromName: (n: string) => { doNames.push(n); return n; },
				get: () => ({
					createEmail: async (_f: string, row: { recipient?: string }) => { stored.push(row); },
					checkSendRateLimit: async () => null,
				}),
			},
		} as never;
		const res = await app.request(
			`/api/v1/mailboxes/postel@mail.build/send`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ to, subject: "s", text: "t" }),
			},
			env,
		);
		return { res, heads, doNames, stored };
	}

	it("accepts a +tag recipient whose BASE mailbox exists (was a 404)", async () => {
		const { res, heads, doNames, stored } = await sendTo("postel+baseline@mail.build", ["postel@mail.build"]);
		expect(res.status).toBe(202);
		expect(heads).toContain("mailboxes/postel@mail.build.json"); // existence checked on the base
		expect(doNames).toContain("postel@mail.build"); // delivered to the base mailbox
		// the tag is preserved on the stored message so it stays filterable
		expect(stored[0].recipient).toBe("postel+baseline@mail.build");
	});

	it("still 404s when the BASE mailbox does not exist", async () => {
		const { res } = await sendTo("ghost+tag@mail.build", ["postel@mail.build"]);
		expect(res.status).toBe(404);
		const body = await res.json() as { error: string };
		expect(body.error).toContain("ghost@mail.build"); // names the base, not the tag
	});
});
