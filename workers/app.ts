// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import { resolveKey } from "./lib/keyRegistry";
import type { MailboxContext } from "./lib/mailbox";
import type { Env } from "./types";
import {
	openSession,
	sealSession,
	sessionCookie,
	newLoginState,
	loginStateCookie,
	readLoginState,
	clearLoginStateCookie,
	loginStatesMatch,
} from "./lib/session";
import {
	type RaftOAuthConfig,
	RaftAuthError,
	exchangeAuthorizationCode,
	exchangeAgentRequest,
	fetchUserinfo,
	validateRaftPrincipal,
	ownerFromPrincipal,
	raftSetupUrl,
} from "./lib/raftAuth";

const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8h
const LOGIN_STATE_TTL_SECONDS = 600; // 10min

/** True when Login-with-Raft is configured (mail.build): all four env pieces present. */
function raftLoginConfigured(env: Env): boolean {
	return Boolean(env.RAFT_API_ORIGIN && env.RAFT_APP_ORIGIN && env.RAFT_OAUTH_CLIENT_KEY && env.RAFT_OAUTH_CLIENT_SECRET && env.RAFT_SESSION_SECRET);
}

/** Read the Login-with-Raft OAuth config from env (call only when raftLoginConfigured). */
function readRaftConfig(env: Env): RaftOAuthConfig {
	return {
		apiOrigin: (env.RAFT_API_ORIGIN ?? "").replace(/\/+$/, ""),
		appOrigin: (env.RAFT_APP_ORIGIN ?? "").replace(/\/+$/, ""),
		clientKey: env.RAFT_OAUTH_CLIENT_KEY ?? "",
		clientSecret: env.RAFT_OAUTH_CLIENT_SECRET ?? "",
		allowedServerIds: (env.ALLOWED_SERVER_IDS ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
	};
}

/** A request that should get an HTML redirect (browser nav) vs a JSON 401 (api/programmatic). */
function wantsHtmlRedirect(request: Request): boolean {
	const path = new URL(request.url).pathname;
	if (path.startsWith("/api/") || path.startsWith("/mcp")) return false;
	return (request.headers.get("Accept") ?? "").includes("text/html");
}

/** Paths that must never be gated by the auth middleware: the login flow and the
 * public agent-behavior manifest (the Raft integration CLI fetches it anonymously). */
function isAuthExemptPath(pathname: string): boolean {
	return (
		pathname.startsWith("/auth/raft/") ||
		pathname === "/auth/callback" ||
		pathname === "/.well-known/raft-agent-manifest.json"
	);
}

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";
export { OwnerDO } from "./ownerDO";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

// Main app that wraps the API and adds React Router fallback. Shares the
// MailboxContext so the auth middleware can set authOwner/authScope for the
// mounted API routes to read.
const app = new Hono<MailboxContext>();
// Cloudflare Access JWT validation middleware (production only)
app.use("*", async (c, next) => {
	// Skip validation in development
	if (import.meta.env.DEV) {
		return next();
	}

	// Login-flow endpoints establish identity; they must never be auth-gated.
	const path = new URL(c.req.url).pathname;
	if (isAuthExemptPath(path)) {
		return next();
	}

	const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");

	// 1. Per-agent scoped key (Bearer) — programmatic agent access.
	if (bearer) {
		const key = await resolveKey(c.env, bearer);
		if (key) {
			c.set("authOwner", key.owner);
			c.set("authScope", key.scope);
			c.set("authIsAdmin", key.scope === "admin");
			return next();
		}
	}

	// 2. Login-with-Raft session (cookie) — human or agent signed in via OAuth.
	//    The server allow-list (botiverse-only) was enforced ONCE at login in
	//    validateRaftPrincipal; a sealed session is proof of that, so we trust the
	//    owner here and do NOT re-check the server per request.
	if (c.env.RAFT_SESSION_SECRET) {
		const session = await openSession(c.req.raw, c.env.RAFT_SESSION_SECRET);
		if (session) {
			c.set("authOwner", ownerFromPrincipal(session.principal));
			c.set("authScope", "account");
			c.set("authIsAdmin", false);
			if (session.principal.preferredUsername) c.set("authHandle", session.principal.preferredUsername);
			return next();
		}
	}

	// 3. Legacy global API_KEY — temporary admin fallback during cutover (removed
	//    once all consumers hold scoped keys). See notes/design-per-agent-auth.md #2.
	const apiKey = c.env.API_KEY;
	if (apiKey && bearer === apiKey) {
		c.set("authOwner", "local:admin");
		c.set("authScope", "admin");
		c.set("authIsAdmin", true);
		return next();
	}

	// 4a. No identity, Login-with-Raft configured (mail.build): raft-login is the
	//     gate. JSON 401 for api/programmatic; 302 to the login page for browsers.
	if (raftLoginConfigured(c.env)) {
		if (wantsHtmlRedirect(c.req.raw)) {
			const nextParam = encodeURIComponent(path + new URL(c.req.url).search);
			return c.redirect(`/auth/raft/login?next=${nextParam}`, 302);
		}
		return c.json({ error: "Authentication required" }, 401);
	}

	// 4b. Legacy Cloudflare Access gate (workers.dev) — only active when configured
	//     and raft-login is not. Inert on mail.build (POLICY_AUD/TEAM_DOMAIN unset).
	const { POLICY_AUD, TEAM_DOMAIN } = c.env;
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Auth not configured: set Login-with-Raft (RAFT_*) or Cloudflare Access (POLICY_AUD/TEAM_DOMAIN).",
			500,
		);
	}
	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return c.text("Missing required CF Access JWT", 403);
	}
	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		await jwtVerify(token, JWKS, { issuer, audience: POLICY_AUD });
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}
	// Authorization model note: once a teammate passes the shared Cloudflare Access
	// policy, they can access all mailboxes in this app by design.
	return next();
});

// ── Agent-behavior manifest (public; the Raft integration CLI fetches it) ─────
// Describes the login-with-raft auth + the HTTP API actions agents can call.
// Origins are derived from the request so the same route is valid on both the
// workers.dev interim URL and mail.build.
app.get("/.well-known/raft-agent-manifest.json", (c) => {
	const origin = new URL(c.req.url).origin;
	return c.json(
		{
			schema: "raft-agent-manifest.v0",
			name: "Agentic Inbox",
			description: "Per-agent email inbox on mail.build. Login with Raft, claim a mailbox under your handle, then RECEIVE and READ email. v0 is inbound-only: there is no send/reply action yet (well-suited to receiving verification codes / links). Claiming an existing ownerless mailbox under your handle adopts it.",
			service: "agentic-inbox",
			app_origin: origin,
			docs_url: "https://docs.raft.build/developers/login-with-raft/",
			execution: { mode: "http_api", base_url: origin },
			auth: { type: "login_with_raft", login_url: `${origin}/auth/raft/login` },
			// A cheap authenticated call that returns the caller's own mailboxes = context.
			context_check: { url: `${origin}/api/v1/mailboxes`, method: "GET" },
			actions: [
				{
					name: "claim-mailbox",
					description: "Claim a mailbox under your own handle namespace (<handle>@ or <handle>-*). If the address already exists but is ownerless, it is adopted (you become the owner). Returns a mailbox-scoped access key, shown once — raft-native (integration) calls authenticate via your stored session and do not need this key.",
					endpoint: { method: "POST", path: "/api/v1/mailboxes" },
				},
				{
					name: "list-mailboxes",
					description: "List the mailboxes you own.",
					endpoint: { method: "GET", path: "/api/v1/mailboxes" },
				},
				{
					name: "list-emails",
					description: "List emails in one of your mailboxes (optionally by folder).",
					endpoint: { method: "GET", path: "/api/v1/mailboxes/{mailboxId}/emails" },
				},
				{
					name: "get-email",
					description: "Read a single email in one of your mailboxes. Returns a structured (not raw MIME) object: from/to (aliases of sender/recipient), subject, date, body_text (HTML stripped to plain — safe to grep for codes/links), body_html (null when there was no HTML part), snippet, read, and raw_headers.",
					endpoint: { method: "GET", path: "/api/v1/mailboxes/{mailboxId}/emails/{id}" },
				},
				{
					name: "release-mailbox",
					description: "Release (delete) a mailbox you own, freeing the quota slot so you can claim another. Use this to clean up throwaway / verification mailboxes.",
					endpoint: { method: "DELETE", path: "/api/v1/mailboxes/{mailboxId}" },
				},
				{
					name: "send-mail",
					description: "Send a message FROM a mailbox you own TO another mailbox on this service (v0 is internal-only — agent-to-agent within the configured domain; the recipient mailbox must already exist). Body: {to, subject, text, html?}. No external/outbound delivery yet.",
					endpoint: { method: "POST", path: "/api/v1/mailboxes/{mailboxId}/send" },
				},
			],
		},
		200,
		{ "Cache-Control": "public, max-age=300" },
	);
});

// ── Login-with-Raft OAuth routes (exempt from the auth middleware above) ──────
// Browser (human) flow uses CSRF state + authorization_code; agent CLI flow uses
// the agent_request grant with state forbidden. Both seal a session cookie that the
// middleware maps to authOwner/authScope/authHandle.
app.get("/auth/raft/login", async (c) => {
	if (!raftLoginConfigured(c.env)) return c.text("Login-with-Raft is not configured", 500);
	const config = readRaftConfig(c.env);
	const state = newLoginState();
	const callbackUrl = new URL("/auth/raft/callback", c.req.url).toString();
	const location = raftSetupUrl(config, callbackUrl, state);
	c.header("Set-Cookie", loginStateCookie(c.req.raw, state, LOGIN_STATE_TTL_SECONDS));
	c.header("Cache-Control", "no-store");
	return c.redirect(location, 302);
});

app.all("/auth/raft/callback", async (c) => {
	if (!raftLoginConfigured(c.env)) return c.text("Login-with-Raft is not configured", 500);
	const config = readRaftConfig(c.env);
	const url = new URL(c.req.url);
	const code = url.searchParams.get("code") ?? "";
	const presentedState = url.searchParams.get("state");
	const expectedState = readLoginState(c.req.raw);
	// Browser flow iff a state is present on either side; agent flow otherwise.
	const browserFlow = presentedState !== null || expectedState !== null;
	try {
		let token;
		if (browserFlow) {
			// CSRF: presented state must match the cookie state (constant-time).
			if (!presentedState || !expectedState || !(await loginStatesMatch(presentedState, expectedState))) {
				throw new RaftAuthError("RAFT_STATE_MISMATCH", "token_exchange_failed", 400);
			}
			token = await exchangeAuthorizationCode(config, code, url.toString().split("?")[0]);
		} else {
			// Agent flow: `code` carries the agent request id; state must be absent.
			token = await exchangeAgentRequest(config, code);
		}
		const userinfo = await fetchUserinfo(config, token.access_token);
		const principal = validateRaftPrincipal(userinfo, config);
		const ttl = Math.max(1, Math.min(typeof token.expires_in === "number" ? token.expires_in : SESSION_TTL_SECONDS, SESSION_TTL_SECONDS));
		const sealed = await sealSession({ principal, expiresAt: Date.now() + ttl * 1000 }, c.env.RAFT_SESSION_SECRET as string);
		// Two Set-Cookie headers (session + clear login-state) MUST both survive —
		// use append (c.header replaces by default, which would drop the session cookie).
		c.header("Set-Cookie", sessionCookie(c.req.raw, sealed, ttl), { append: true });
		c.header("Set-Cookie", clearLoginStateCookie(c.req.raw), { append: true });
		c.header("Cache-Control", "no-store");
		// Browser: bounce to `next` (validated same-origin) or home. Agent: 204.
		if (browserFlow) {
			const requested = url.searchParams.get("next") ?? "/";
			const nextPath = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
			return c.redirect(nextPath, 302);
		}
		return c.body(null, 204);
	} catch (err) {
		const status = err instanceof RaftAuthError ? err.status : 403;
		if (err instanceof RaftAuthError) console.warn("[raft-auth]", err.code, err.reason);
		return c.json({ error: "Login could not be completed." }, status as 400 | 403 | 500, { "Set-Cookie": clearLoginStateCookie(c.req.raw), "Cache-Control": "no-store" });
	}
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
