// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { withRaftHostAutoSignIn } from "./raftHostSignIn";
import { type RaftPrincipal, sealSession, sessionCookie } from "./session";

const SECRET = "test-session-secret-please-rotate";
const env = { RAFT_SESSION_SECRET: SECRET };
const principal: RaftPrincipal = {
	sub: "5af46a83-44d3-4a87-aea2-e1ac2f67c9a3",
	type: "human",
	serverId: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
	clientId: "agentic-inbox",
	preferredUsername: "artin",
	name: "artin",
	serverSlug: "botiverse",
	plan: "free",
};

// Stands in for app.fetch: the landing page / app shell.
const inner = async () => new Response("<html>page</html>", { status: 200, headers: { "Content-Type": "text/html" } });
const handler = withRaftHostAutoSignIn(() => true, inner);

function page(path: string, headers: Record<string, string> = {}): Request {
	return new Request(`https://mail.build${path}`, {
		headers: { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", ...headers },
	});
}

describe("Raft-Host auto sign-in", () => {
	it("sends a visitor with no session to Login with Raft, keeping the page as next", async () => {
		const res = await handler(page("/mailbox/abc?folder=inbox", { "Raft-Host": "desktop" }), env);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/auth/raft/login?next=%2Fmailbox%2Fabc%3Ffolder%3Dinbox");
		expect(res.headers.get("Set-Cookie")).toMatch(/raft_host_signin_guard=/);
		expect(res.headers.get("Vary")).toMatch(/Raft-Host/);
	});

	it.each(["ios", "android"])("redirects for Raft-Host: %s too", async (host) => {
		const res = await handler(page("/", { "Raft-Host": host }), env);
		expect(res.status).toBe(302);
	});

	it("leaves a request without Raft-Host alone, but marks the page Vary: Raft-Host", async () => {
		const res = await handler(page("/"), env);
		expect(res.status).toBe(200);
		expect(res.headers.get("Vary")).toMatch(/Raft-Host/);
	});

	it("does not redirect after the person cancelled Raft's sheet (?error=access_denied)", async () => {
		const res = await handler(page("/?error=access_denied", { "Raft-Host": "desktop" }), env);
		expect(res.status).toBe(200);
	});

	it("does not redirect again while the guard cookie from the last try is set", async () => {
		const first = await handler(page("/", { "Raft-Host": "desktop" }), env);
		const guard = (first.headers.get("Set-Cookie") ?? "").split(";")[0];
		const res = await handler(page("/", { "Raft-Host": "desktop", Cookie: guard }), env);
		expect(res.status).toBe(200);
	});

	it("does not redirect a visitor who already has a session", async () => {
		const sealed = await sealSession({ principal, expiresAt: Date.now() + 60_000 }, SECRET);
		const cookie = sessionCookie(new Request("https://mail.build/"), sealed, 60).split(";")[0];
		const res = await handler(page("/", { "Raft-Host": "desktop", Cookie: cookie }), env);
		expect(res.status).toBe(200);
	});

	it("never redirects public paths or the login route itself", async () => {
		for (const path of ["/docs", "/health", "/auth/raft/login", "/auth/raft/callback?code=x&state=y"]) {
			const res = await handler(page(path, { "Raft-Host": "desktop" }), env);
			expect(res.status, path).toBe(200);
		}
	});

	it("does not touch API calls", async () => {
		const res = await handler(
			new Request("https://mail.build/api/v1/mailboxes", { headers: { Accept: "application/json", "Raft-Host": "desktop" } }),
			env,
		);
		expect(res.status).toBe(200);
	});

	it("is off when Login with Raft is not configured", async () => {
		const off = withRaftHostAutoSignIn(() => false, inner);
		const res = await off(page("/", { "Raft-Host": "desktop" }), env);
		expect(res.status).toBe(200);
		expect(res.headers.get("Vary")).toBeNull();
	});
});
