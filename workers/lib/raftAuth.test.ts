// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import type { RaftPrincipal } from "./session";
import {
	type RaftOAuthConfig,
	RaftAuthError,
	exchangeAuthorizationCode,
	exchangeAgentRequest,
	fetchUserinfo,
	validateRaftPrincipal,
	ownerFromPrincipal,
	raftSetupUrl,
	isBrowserCallbackFlow,
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
	it("accepts valid botiverse userinfo and trusts only immutable claims", async () => {
		const p = await validateRaftPrincipal(validUserinfo, config);
		expect(p.sub).toBe(validUserinfo.sub);
		expect(p.type).toBe("agent");
		expect(p.serverId).toBe(validUserinfo.server_id);
		expect(p.preferredUsername).toBe("Gogo");
	});
	it("rejects a non-botiverse server (server_not_allowed) when Flagship is absent", async () => {
		const bad = { ...validUserinfo, server_id: "deadbeef-0000-0000-0000-000000000000" };
		await expect(validateRaftPrincipal(bad, config)).rejects.toThrowError(RaftAuthError);
		try { await validateRaftPrincipal(bad, config); } catch (e) {
			expect((e as RaftAuthError).reason).toBe("server_not_allowed");
			expect((e as RaftAuthError).suggestedNextAction).toContain("ALLOWED_SERVER_IDS");
		}
	});
	it("accepts a server allowed dynamically via Cloudflare Flagship binding", async () => {
		const customServer = { ...validUserinfo, server_id: "custom-server-uuid" };
		const mockFlags = {
			getBooleanValue: async (key: string, def: boolean, ctx?: Record<string, any>) => {
				if (key === "server-allowed" && ctx?.serverId === "custom-server-uuid") return true;
				return def;
			},
		} as any;
		const p = await validateRaftPrincipal(customServer, config, mockFlags);
		expect(p.serverId).toBe("custom-server-uuid");
	});
	it("rejects a token minted for a different client (client_not_allowed)", async () => {
		const bad = { ...validUserinfo, client_id: "some-other-app" };
		try { await validateRaftPrincipal(bad, config); expect.fail("should throw"); }
		catch (e) { expect((e as RaftAuthError).reason).toBe("client_not_allowed"); }
	});
	it("rejects missing required claims (userinfo_malformed)", async () => {
		for (const k of ["sub", "type", "server_id", "client_id"]) {
			const bad = { ...validUserinfo } as Record<string, unknown>;
			delete bad[k];
			try { await validateRaftPrincipal(bad, config); expect.fail(`should throw for missing ${k}`); }
			catch (e) { expect((e as RaftAuthError).reason).toBe("userinfo_malformed"); }
		}
	});
	it("rejects an invalid principal type", async () => {
		const bad = { ...validUserinfo, type: "robot" };
		try { await validateRaftPrincipal(bad, config); expect.fail("should throw"); }
		catch (e) { expect((e as RaftAuthError).reason).toBe("principal_type_invalid"); }
	});
	it("accepts a valid HUMAN principal (browser authorization_code path — never live-run yet)", async () => {
		const human = { ...validUserinfo, type: "human", sub: "human-sub-1111", preferred_username: "artea", name: "Artea" };
		const p = await validateRaftPrincipal(human, config);
		expect(p.type).toBe("human");
		expect(p.sub).toBe("human-sub-1111");
		expect(p.serverId).toBe(validUserinfo.server_id);
		expect(p.preferredUsername).toBe("artea");
	});
});

describe("ownerFromPrincipal", () => {
	const agentPrincipal: RaftPrincipal = {
		sub: validUserinfo.sub,
		type: "agent",
		serverId: validUserinfo.server_id,
		clientId: validUserinfo.client_id,
		preferredUsername: validUserinfo.preferred_username,
		name: validUserinfo.name,
	};
	const humanPrincipal: RaftPrincipal = {
		sub: "human-sub-1111",
		type: "human",
		serverId: validUserinfo.server_id,
		clientId: validUserinfo.client_id,
		preferredUsername: "artea",
		name: "Artea",
	};

	it("is raft:server:type:sub", () => {
		expect(ownerFromPrincipal(agentPrincipal)).toBe(`raft:${validUserinfo.server_id}:agent:${validUserinfo.sub}`);
	});
	it("embeds type=human for a human principal", () => {
		expect(ownerFromPrincipal(humanPrincipal)).toBe(`raft:${validUserinfo.server_id}:human:human-sub-1111`);
	});
	it("separates human vs agent owners by type — the mailbox-isolation guarantee (even at identical sub/server)", () => {
		expect(ownerFromPrincipal(agentPrincipal)).not.toBe(ownerFromPrincipal(humanPrincipal));
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

describe("isBrowserCallbackFlow", () => {
	it("identifies browser flow when expectedState cookie is present", () => {
		expect(isBrowserCallbackFlow("some-login-state-cookie")).toBe(true);
	});
	it("identifies agent flow when expectedState cookie is absent, even if presentedState exists", () => {
		// Legacy CLI sends `state` in the callback URL without a cookie. Must route to agent flow.
		expect(isBrowserCallbackFlow(null)).toBe(false);
	});
});
