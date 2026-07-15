// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import {
	type RaftPrincipal,
	sealSession,
	openSession,
	sessionCookie,
	newLoginState,
	loginStatesMatch,
} from "./session";

const SECRET = "test-session-secret-please-rotate";
const principal: RaftPrincipal = {
	sub: "5af46a83-44d3-4a87-aea2-e1ac2f67c9a3",
	type: "agent",
	serverId: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
	clientId: "agentic-inbox",
	preferredUsername: "Gogo",
	name: "Gogo",
};

function reqWithCookie(setCookie: string): Request {
	// A Set-Cookie header is `name=value; attrs`; the Cookie request header wants `name=value`.
	const pair = setCookie.split(";")[0];
	return new Request("https://mail.build/api/v1/mailboxes", { headers: { Cookie: pair } });
}

describe("session seal/open round-trip", () => {
	it("opens a freshly sealed, unexpired session back to the same principal", async () => {
		const sealed = await sealSession({ principal, expiresAt: Date.now() + 60_000 }, SECRET);
		const cookie = sessionCookie(new Request("https://mail.build/"), sealed, 60);
		const opened = await openSession(reqWithCookie(cookie), SECRET);
		expect(opened?.principal.sub).toBe(principal.sub);
		expect(opened?.principal.type).toBe("agent");
		expect(opened?.principal.serverId).toBe(principal.serverId);
	});

	it("returns null for an expired session", async () => {
		const sealed = await sealSession({ principal, expiresAt: Date.now() - 1 }, SECRET);
		const cookie = sessionCookie(new Request("https://mail.build/"), sealed, 60);
		expect(await openSession(reqWithCookie(cookie), SECRET)).toBeNull();
	});

	it("returns null when opened with the wrong secret (AES-GCM auth fails)", async () => {
		const sealed = await sealSession({ principal, expiresAt: Date.now() + 60_000 }, SECRET);
		const cookie = sessionCookie(new Request("https://mail.build/"), sealed, 60);
		expect(await openSession(reqWithCookie(cookie), "a-different-secret")).toBeNull();
	});

	it("returns null for a tampered ciphertext", async () => {
		const sealed = await sealSession({ principal, expiresAt: Date.now() + 60_000 }, SECRET);
		const [iv, ct] = sealed.split(".");
		const flipped = ct.slice(0, -1) + (ct.slice(-1) === "A" ? "B" : "A");
		const cookie = sessionCookie(new Request("https://mail.build/"), `${iv}.${flipped}`, 60);
		expect(await openSession(reqWithCookie(cookie), SECRET)).toBeNull();
	});

	it("returns null when there is no session cookie", async () => {
		const req = new Request("https://mail.build/api/v1/mailboxes");
		expect(await openSession(req, SECRET)).toBeNull();
	});

	it("rejects a sealed payload whose principal shape is invalid (defense-in-depth)", async () => {
		const bad = { ...principal, type: "robot" } as unknown as RaftPrincipal;
		const sealed = await sealSession({ principal: bad, expiresAt: Date.now() + 60_000 }, SECRET);
		const cookie = sessionCookie(new Request("https://mail.build/"), sealed, 60);
		expect(await openSession(reqWithCookie(cookie), SECRET)).toBeNull();
	});
});

describe("session cookie attributes", () => {
	it("is HttpOnly + SameSite=Lax + Secure on https", () => {
		const c = sessionCookie(new Request("https://mail.build/"), "v", 60);
		expect(c).toContain("HttpOnly");
		expect(c).toContain("SameSite=Lax");
		expect(c).toContain("Secure");
	});
	it("omits Secure on http (local dev)", () => {
		const c = sessionCookie(new Request("http://localhost:8787/"), "v", 60);
		expect(c).not.toContain("Secure");
	});
	it("throws on a non-absolute path", () => {
		expect(() => sessionCookie(new Request("https://mail.build/"), "v", 60, "relative")).toThrow();
	});
});

describe("CSRF login-state", () => {
	it("newLoginState is a 43-char base64url token", () => {
		expect(newLoginState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});
	it("matches equal states and rejects different ones (constant-time)", async () => {
		const s = newLoginState();
		expect(await loginStatesMatch(s, s)).toBe(true);
		expect(await loginStatesMatch(s, newLoginState())).toBe(false);
	});
	it("rejects malformed states", async () => {
		const s = newLoginState();
		expect(await loginStatesMatch("short", s)).toBe(false);
		expect(await loginStatesMatch(s, "")).toBe(false);
	});
});
