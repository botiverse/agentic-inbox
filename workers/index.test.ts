import { describe, it, expect } from "vitest";
import { app } from "./index";

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
