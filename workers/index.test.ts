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

// --- External sending: allow-listed only, and failures must be loud ------------
// artin enabled Cloudflare Email Sending on the mail.build apex and chose to start
// with a domain allow-list, because outbound deliverability had never been
// measured. These lock the routing decision: internal vs allowed-external vs
// refused, and that a provider failure is NOT reported as success.

describe("send routing: internal / allow-listed external / refused", () => {
	function env(sendImpl?: (m: unknown) => Promise<void>) {
		const sent: unknown[] = [];
		const stored: Array<{ folder: string; row: Record<string, unknown> }> = [];
		const e = {
			DOMAINS: "mail.build",
			EXTERNAL_SEND_DOMAINS: "gmail.com,cat.ms",
			EMAIL_ADDRESSES: [],
			// the real helper reads `result.messageId`, so the fake must return it
			EMAIL: { send: sendImpl ?? (async (m: unknown) => { sent.push(m); return { messageId: "test-msg-id" }; }) },
			BUCKET: {
				head: async (k: string) => (k === "mailboxes/postel@mail.build.json" ? {} : null),
				get: async (k: string) =>
					k === "mailboxes/postel@mail.build.json" ? { json: async () => ({ owner: "t" }) } : null,
			},
			MAILBOX: {
				idFromName: (n: string) => n,
				get: () => ({
					createEmail: async (folder: string, row: Record<string, unknown>) => { stored.push({ folder, row }); },
					checkSendRateLimit: async () => null,
				}),
			},
		} as never;
		return { e, sent, stored };
	}
	async function send(to: string, envObj: never) {
		return app.request("/api/v1/mailboxes/postel@mail.build/send", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ to, subject: "s", text: "t" }),
		}, envObj);
	}

	it("refuses a domain that is NOT on the allow-list, and names what IS allowed", async () => {
		const { e, sent } = env();
		const res = await send("someone@not-allowed.example", e);
		expect(res.status).toBe(400);
		const b = await res.json() as { code: string; allowedExternalDomains: string[] };
		expect(b.code).toBe("SEND_EXTERNAL_UNSUPPORTED");
		expect(b.allowedExternalDomains).toEqual(["gmail.com", "cat.ms"]);
		expect(sent).toHaveLength(0); // nothing was handed to the provider
	});

	it("sends to an allow-listed external domain via the provider", async () => {
		const { e, sent, stored } = env();
		const res = await send("artin@cat.ms", e);
		expect(res.status).toBe(202);
		expect((await res.json() as { delivery: string }).delivery).toBe("external");
		expect(sent).toHaveLength(1);
		// a copy is filed in Sent, marked external
		expect(stored.some((x) => x.folder === "sent")).toBe(true);
	});

	it("does NOT require an external recipient to exist as a local mailbox", async () => {
		// the receiving server answers that, with a bounce — the behaviour we just
		// gave our own inbound path. A 404 here would be us guessing.
		const { e } = env();
		expect((await send("nobody@gmail.com", e)).status).toBe(202);
	});

	it("still delivers internally without touching the provider", async () => {
		const { e, sent, stored } = env();
		const res = await send("postel+tag@mail.build", e);
		expect(res.status).toBe(202);
		expect((await res.json() as { delivery: string }).delivery).toBe("internal");
		expect(sent).toHaveLength(0);
		expect(stored.some((x) => x.folder === "inbox")).toBe(true);
	});

	it("reports a provider failure as 502, NOT as a successful send", async () => {
		// The whole point of tonight's inbound work: never return success for
		// something that did not happen.
		const { e, stored } = env(async () => { throw new Error("provider refused"); });
		const res = await send("artin@cat.ms", e);
		expect(res.status).toBe(502);
		expect((await res.json() as { code: string }).code).toBe("SEND_FAILED");
		expect(stored).toHaveLength(0); // and it is NOT filed as Sent
	});
});
