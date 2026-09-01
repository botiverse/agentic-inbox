// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox";
import {
	sealSession,
	sessionCookie,
	newLoginState,
	loginStateCookie,
	readLoginState,
	clearLoginStateCookie,
	loginStatesMatch,
} from "../lib/session";
import {
	type RaftOAuthConfig,
	RaftAuthError,
	GENERIC_LOGIN_FAILURE,
	exchangeAuthorizationCode,
	exchangeAgentRequest,
	fetchUserinfo,
	validateRaftPrincipal,
	raftSetupUrl,
	isBrowserCallbackFlow,
} from "../lib/raftAuth";

const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8h
const LOGIN_STATE_TTL_SECONDS = 600; // 10min

export function raftLoginConfigured(env: any): boolean {
	return (
		typeof env.RAFT_OAUTH_CLIENT_KEY === "string" &&
		!!env.RAFT_OAUTH_CLIENT_KEY &&
		typeof env.RAFT_OAUTH_CLIENT_SECRET === "string" &&
		!!env.RAFT_OAUTH_CLIENT_SECRET &&
		typeof env.RAFT_SESSION_SECRET === "string" &&
		!!env.RAFT_SESSION_SECRET &&
		typeof env.RAFT_API_ORIGIN === "string" &&
		!!env.RAFT_API_ORIGIN &&
		typeof env.RAFT_APP_ORIGIN === "string" &&
		!!env.RAFT_APP_ORIGIN
	);
}

export function readRaftConfig(env: any): RaftOAuthConfig {
	return {
		apiOrigin: env.RAFT_API_ORIGIN as string,
		appOrigin: env.RAFT_APP_ORIGIN as string,
		clientKey: env.RAFT_OAUTH_CLIENT_KEY as string,
		clientSecret: env.RAFT_OAUTH_CLIENT_SECRET as string,
		allowedServerIds: (typeof env.ALLOWED_SERVER_IDS === "string" ? env.ALLOWED_SERVER_IDS.split(",") : [])
			.map((s) => s.trim())
			.filter(Boolean),
	};
}

const authApp = new Hono<MailboxContext>();

authApp.get("/auth/raft/login", async (c) => {
	const url = new URL(c.req.url);
	// Agent CLI pre-fetch: do not set a CSRF state cookie in the CLI jar.
	if (url.searchParams.get("flow") === "agent") {
		c.header("Set-Cookie", clearLoginStateCookie(c.req.raw));
		c.header("Cache-Control", "no-store");
		return c.body(null, 204);
	}
	if (!raftLoginConfigured(c.env)) return c.text("Login-with-Raft is not configured", 500);
	const config = readRaftConfig(c.env);
	const state = newLoginState();
	const callbackUrl = new URL("/auth/raft/callback", c.req.url);
	if (callbackUrl.hostname !== "localhost" && callbackUrl.hostname !== "127.0.0.1") {
		callbackUrl.protocol = "https:";
	}
	const location = raftSetupUrl(config, callbackUrl.toString(), state);
	c.header("Set-Cookie", loginStateCookie(c.req.raw, state, LOGIN_STATE_TTL_SECONDS));
	c.header("Cache-Control", "no-store");
	return c.redirect(location, 302);
});

authApp.all("/auth/raft/callback", async (c) => {
	if (!raftLoginConfigured(c.env)) return c.text("Login-with-Raft is not configured", 500);
	const config = readRaftConfig(c.env);
	const url = new URL(c.req.url);
	const code = url.searchParams.get("code") ?? "";
	const presentedState = url.searchParams.get("state");
	const expectedState = readLoginState(c.req.raw);
	// Browser flow requires an active login-state cookie from /auth/raft/login; agent flow otherwise.
	const browserFlow = isBrowserCallbackFlow(expectedState);
	try {
		let token;
		if (browserFlow) {
			if (!presentedState || !expectedState || !(await loginStatesMatch(presentedState, expectedState))) {
				throw new RaftAuthError("RAFT_STATE_MISMATCH", "token_exchange_failed", 400);
			}
			token = await exchangeAuthorizationCode(config, code, url.toString().split("?")[0]);
		} else {
			token = await exchangeAgentRequest(config, code);
		}
		const userinfo = await fetchUserinfo(config, token.access_token);
		const principal = await validateRaftPrincipal(userinfo, config, c.env.FLAGS);
		const ttl = Math.max(1, Math.min(typeof token.expires_in === "number" ? token.expires_in : SESSION_TTL_SECONDS, SESSION_TTL_SECONDS));
		const sealed = await sealSession({ principal, expiresAt: Date.now() + ttl * 1000 }, c.env.RAFT_SESSION_SECRET as string);
		c.header("Set-Cookie", sessionCookie(c.req.raw, sealed, ttl), { append: true });
		c.header("Set-Cookie", clearLoginStateCookie(c.req.raw), { append: true });
		c.header("Cache-Control", "no-store");
		if (browserFlow) {
			const requested = url.searchParams.get("next") ?? "/";
			const nextPath = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
			return c.redirect(nextPath, 302);
		}
		return c.body(null, 204);
	} catch (err) {
		const status = err instanceof RaftAuthError ? err.status : 403;
		if (err instanceof RaftAuthError) {
			console.warn("[raft-auth]", err.code, err.reason);
			return c.json(
				{
					error: err.message,
					errorCode: err.code,
					reason: err.reason,
					suggestedNextAction: err.suggestedNextAction,
				},
				status as 400 | 403 | 500,
				{ "Set-Cookie": clearLoginStateCookie(c.req.raw), "Cache-Control": "no-store" },
			);
		}
		console.error("Login-with-Raft unexpected callback failure:", (err as Error).message, (err as Error).stack);
		return c.json(
			{
				error: GENERIC_LOGIN_FAILURE,
				errorCode: "LOGIN_FAILED",
			},
			500,
			{ "Set-Cookie": clearLoginStateCookie(c.req.raw), "Cache-Control": "no-store" },
		);
	}
});

export { authApp };
