// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import {
	type RaftOAuthConfig,
	RaftAuthError,
	exchangeAuthorizationCode,
	exchangeAgentRequest,
	fetchUserinfo,
	validateRaftPrincipal,
	ownerFromPrincipal,
	raftSetupUrl,
} from "./raftAuth";

const config: RaftOAuthConfig = {
	apiOrigin: "https://api.raft.build",
	appOrigin: "https://app.raft.build",
	clientKey: "agentic-inbox",
	clientSecret: "s3cret",
	allowedServerIds: ["95f993fa-2a68-4797-b8ae-7beb7d984ada"],
};

const validUserinfo = {
	sub: "5af46a83-44d3-4a87-aea2-e1ac2f67c9a3",
	type: "agent",
	server_id: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
	client_id: "agentic-inbox",
	preferred_username: "Gogo",
	name: "Gogo",
};

/** Capture the outgoing request and reply with `body` (json) at `status`. */
function mockFetch(captured: { req?: Request; bodyText?: string }, body: unknown, status = 200): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input as Request | string, init);
		captured.req = req;
		captured.bodyText = init?.body ? String(init.body) : await req.clone().text().catch(() => "");
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
}

describe("validateRaftPrincipal", () => {
	it("accepts valid botiverse userinfo and trusts only immutable claims", () => {
		const p = validateRaftPrincipal(validUserinfo, config);
		expect(p.sub).toBe(validUserinfo.sub);
		expect(p.type).toBe("agent");
		expect(p.serverId).toBe(validUserinfo.server_id);
		expect(p.preferredUsername).toBe("Gogo");
	});
	it("rejects a non-botiverse server (server_not_allowed)", () => {
		const bad = { ...validUserinfo, server_id: "deadbeef-0000-0000-0000-000000000000" };
		expect(() => validateRaftPrincipal(bad, config)).toThrowError(RaftAuthError);
		try { validateRaftPrincipal(bad, config); } catch (e) { expect((e as RaftAuthError).reason).toBe("server_not_allowed"); }
	});
	it("rejects a token minted for a different client (client_not_allowed)", () => {
		const bad = { ...validUserinfo, client_id: "some-other-app" };
		try { validateRaftPrincipal(bad, config); expect.fail("should throw"); }
		catch (e) { expect((e as RaftAuthError).reason).toBe("client_not_allowed"); }
	});
	it("rejects missing required claims (userinfo_malformed)", () => {
		for (const k of ["sub", "type", "server_id", "client_id"]) {
			const bad = { ...validUserinfo } as Record<string, unknown>;
			delete bad[k];
			try { validateRaftPrincipal(bad, config); expect.fail(`should throw for missing ${k}`); }
			catch (e) { expect((e as RaftAuthError).reason).toBe("userinfo_malformed"); }
		}
	});
	it("rejects an invalid principal type", () => {
		const bad = { ...validUserinfo, type: "robot" };
		try { validateRaftPrincipal(bad, config); expect.fail("should throw"); }
		catch (e) { expect((e as RaftAuthError).reason).toBe("principal_type_invalid"); }
	});
});

describe("ownerFromPrincipal", () => {
	it("is raft:server:type:sub", () => {
		const p = validateRaftPrincipal(validUserinfo, config);
		expect(ownerFromPrincipal(p)).toBe(`raft:${validUserinfo.server_id}:agent:${validUserinfo.sub}`);
	});
});

describe("token exchange — public clientKey Basic auth, form-urlencoded, correct grant", () => {
	it("human flow uses grant_type=authorization_code + redirect_uri", async () => {
		const cap: { req?: Request; bodyText?: string } = {};
		const token = await exchangeAuthorizationCode(config, "the-code", "https://mail.build/auth/raft/callback", mockFetch(cap, { access_token: "at", expires_in: 3600 }));
		expect(token.access_token).toBe("at");
		expect(cap.req?.url).toBe("https://api.raft.build/api/oauth/token");
		expect(cap.req?.headers.get("Content-Type")).toContain("application/x-www-form-urlencoded");
		expect(cap.req?.headers.get("Authorization")).toBe(`Basic ${btoa("agentic-inbox:s3cret")}`);
		const body = new URLSearchParams(cap.bodyText);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("the-code");
		expect(body.get("redirect_uri")).toBe("https://mail.build/auth/raft/callback");
	});
	it("agent flow uses grant_type=urn:slock:grant-type:agent_request + request_id", async () => {
		const cap: { req?: Request; bodyText?: string } = {};
		await exchangeAgentRequest(config, "req-123", mockFetch(cap, { access_token: "at" }));
		expect(cap.req?.headers.get("Authorization")).toBe(`Basic ${btoa("agentic-inbox:s3cret")}`);
		const body = new URLSearchParams(cap.bodyText);
		expect(body.get("grant_type")).toBe("urn:slock:grant-type:agent_request");
		expect(body.get("request_id")).toBe("req-123");
		expect(body.get("code")).toBeNull();
	});
	it("throws token_exchange_failed on non-ok", async () => {
		const cap: { req?: Request; bodyText?: string } = {};
		await expect(exchangeAgentRequest(config, "x", mockFetch(cap, { error: "nope" }, 403))).rejects.toMatchObject({ reason: "token_exchange_failed" });
	});
	it("empty code/request_id throws missing_code (400) without calling the network", async () => {
		let called = false;
		const spy = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
		await expect(exchangeAuthorizationCode(config, "", "https://mail.build/cb", spy)).rejects.toMatchObject({ reason: "missing_code" });
		expect(called).toBe(false);
	});
});

describe("fetchUserinfo", () => {
	it("sends Bearer access token and returns the userinfo record", async () => {
		const cap: { req?: Request; bodyText?: string } = {};
		const info = await fetchUserinfo(config, "the-access-token", mockFetch(cap, validUserinfo));
		expect(cap.req?.url).toBe("https://api.raft.build/api/oauth/userinfo");
		expect(cap.req?.headers.get("Authorization")).toBe("Bearer the-access-token");
		expect((info as { sub: string }).sub).toBe(validUserinfo.sub);
	});
	it("throws userinfo_failed on non-ok", async () => {
		const cap: { req?: Request; bodyText?: string } = {};
		await expect(fetchUserinfo(config, "x", mockFetch(cap, {}, 401))).rejects.toMatchObject({ reason: "userinfo_failed" });
	});
});

describe("raftSetupUrl", () => {
	it("targets the app origin, uses the PUBLIC clientKey as client_id, and carries state", () => {
		const url = new URL(raftSetupUrl(config, "https://mail.build/auth/raft/callback", "the-state"));
		expect(url.origin).toBe("https://app.raft.build");
		expect(url.pathname).toBe("/login-with-raft/setup");
		expect(url.searchParams.get("client_id")).toBe("agentic-inbox");
		expect(url.searchParams.get("return_to")).toBe("https://mail.build/auth/raft/callback");
		expect(url.searchParams.get("state")).toBe("the-state");
	});
});
