// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { authApp } from "./auth";

const env = {
	RAFT_OAUTH_CLIENT_KEY: "client",
	RAFT_OAUTH_CLIENT_SECRET: "secret",
	RAFT_SESSION_SECRET: "test-session-secret-please-rotate",
	RAFT_API_ORIGIN: "https://api.raft.build",
	RAFT_APP_ORIGIN: "https://app.raft.build",
};

describe("Login-with-Raft callback when the person cancels", () => {
	it("shows the landing page with the sign-in button, not an error", async () => {
		const res = await authApp.request("https://mail.build/auth/raft/callback?error=access_denied&state=s", {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
		expect(await res.text()).toContain('href="/auth/raft/login"');
		expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
	});

	it("still fails a callback with no code and no cancel", async () => {
		const res = await authApp.request("https://mail.build/auth/raft/callback?state=s", {}, env);
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

describe("Login-with-Raft login remembers where the person was going", () => {
	it("keeps a same-origin next path for the callback", async () => {
		const res = await authApp.request("https://mail.build/auth/raft/login?next=%2Fmailbox%2Fabc%3Ffolder%3Dinbox", {}, env);
		expect(res.status).toBe(302);
		const cookies = res.headers.getSetCookie();
		expect(cookies.some((c) => c.startsWith("agentic_inbox_login_state="))).toBe(true);
		expect(cookies).toContainEqual(expect.stringMatching(/^agentic_inbox_login_next=%2Fmailbox%2Fabc%3Ffolder%3Dinbox; Path=\/auth\/raft\/callback;/));
	});

	it.each(["//evil.example/x", "/\\evil.example", "https://evil.example/"])("refuses next=%s", async (next) => {
		const res = await authApp.request(`https://mail.build/auth/raft/login?next=${encodeURIComponent(next)}`, {}, env);
		expect(res.headers.getSetCookie()).toContainEqual(expect.stringMatching(/^agentic_inbox_login_next=; .*Max-Age=0/));
	});
});
