// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Login-with-Raft OAuth for agentic-inbox: dual human(browser) + agent(CLI) flow.
 *
 * Reference-faithful to the two authoritative implementations:
 *  - me.build's principal validation (trust only immutable claims; server/client gate)
 *  - the slock-internal-dashboard fix (PR #66, 2026-07-15): Basic auth uses the
 *    PUBLIC client key (never the internal app UUID), token endpoint is
 *    application/x-www-form-urlencoded, and the agent flow uses the
 *    `urn:slock:grant-type:agent_request` grant with `request_id` — humans use
 *    `authorization_code`. Getting this wrong is exactly the 403 that fix cured.
 *
 * Unlike the dashboard (where agents are context-only), an agentic-inbox agent is
 * a first-class mailbox owner: both flows seal a session the middleware maps to
 * authOwner + authScope="account" + authHandle. botiverse-only login is enforced
 * here via ALLOWED_SERVER_IDS (server_not_allowed).
 */

import type { RaftPrincipal } from "./session";
import { serverAllowed } from "./auth";

export type AuthFailure =
	| "missing_code"
	| "token_exchange_failed"
	| "token_response_malformed"
	| "userinfo_failed"
	| "userinfo_malformed"
	| "server_not_allowed"
	| "principal_type_invalid"
	| "client_not_allowed"
	| "wrong_principal_type";

const GENERIC_LOGIN_FAILURE = "Login could not be completed. Please try again or contact the workspace owner.";

export function authFailureGuidance(reason: AuthFailure): { error: string; suggestedNextAction: string } {
	switch (reason) {
		case "server_not_allowed":
			return {
				error: "This Raft Server is not authorized for mail.build.",
				suggestedNextAction: "Ask the mail.build owner to add this Server ID to ALLOWED_SERVER_IDS, then run `raft integration login --service agentic-inbox` again.",
			};
		case "client_not_allowed":
			return {
				error: "The login token was issued for a different application.",
				suggestedNextAction: "Use the mail.build Agent Login service and contact its owner if the application binding is wrong.",
			};
		case "missing_code":
			return { error: "The login callback is missing its authorization code.", suggestedNextAction: "Restart the Agent Login flow; do not reuse this callback URL." };
		case "token_exchange_failed":
			return { error: "Raft did not accept the login exchange.", suggestedNextAction: "Retry once; if it persists, ask the mail.build owner to inspect the app grant." };
		case "userinfo_failed":
			return { error: "Raft login succeeded, but identity lookup failed.", suggestedNextAction: "Retry once; if it persists, ask the Raft service owner to inspect the token." };
		case "principal_type_invalid":
			return { error: "Raft returned an unsupported principal type.", suggestedNextAction: "Ask the mail.build owner to inspect the Agent Login identity binding." };
		case "token_response_malformed":
		case "userinfo_malformed":
		case "wrong_principal_type":
		default:
			return { error: GENERIC_LOGIN_FAILURE, suggestedNextAction: "Retry once; if it persists, contact the mail.build owner with the error code." };
	}
}

export class RaftAuthError extends Error {
	constructor(
		public readonly code: string,
		public readonly reason: AuthFailure,
		public readonly status = 403,
	) {
		super(GENERIC_LOGIN_FAILURE);
		this.name = "RaftAuthError";
	}
}

export interface RaftOAuthConfig {
	apiOrigin: string; // e.g. https://api.raft.build
	appOrigin: string; // e.g. https://app.raft.build (login-with-raft/setup lives here)
	/** PUBLIC client key (e.g. "agentic-inbox") — used for BOTH the setup client_id AND Basic auth. Never the UUID. */
	clientKey: string;
	clientSecret: string;
	allowedServerIds: readonly string[]; // botiverse-only gate; "*" = any
}

interface TokenResponse {
	access_token: string;
	expires_in?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(rec: Record<string, unknown>, key: string): string | null {
	const v = rec[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}
function base64(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}
/** Basic auth header from the PUBLIC client key (never the internal UUID — PR #66 fix). */
function basicAuth(config: RaftOAuthConfig): string {
	return `Basic ${base64(`${config.clientKey}:${config.clientSecret}`)}`;
}

async function postToken(config: RaftOAuthConfig, body: URLSearchParams, fetchImpl: typeof fetch): Promise<TokenResponse> {
	const res = await fetchImpl(`${config.apiOrigin}/api/oauth/token`, {
		method: "POST",
		headers: { Authorization: basicAuth(config), "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!res.ok) throw new RaftAuthError("RAFT_TOKEN_EXCHANGE_FAILED", "token_exchange_failed");
	const token = (await res.json().catch(() => null)) as Partial<TokenResponse> | null;
	if (!token || typeof token.access_token !== "string" || !token.access_token) {
		throw new RaftAuthError("RAFT_TOKEN_RESPONSE_MALFORMED", "token_response_malformed");
	}
	return token as TokenResponse;
}

/** Human browser flow: authorization_code grant. (async so a bad-input throw surfaces as a rejection) */
export async function exchangeAuthorizationCode(
	config: RaftOAuthConfig,
	code: string,
	redirectUri: string,
	fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
	if (!code) throw new RaftAuthError("RAFT_MISSING_CODE", "missing_code", 400);
	return postToken(config, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }), fetchImpl);
}

/** Agent CLI flow: agent_request grant with request_id (the value arrives in the `code` query param). */
export async function exchangeAgentRequest(
	config: RaftOAuthConfig,
	requestId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
	if (!requestId) throw new RaftAuthError("RAFT_MISSING_CODE", "missing_code", 400);
	return postToken(config, new URLSearchParams({ grant_type: "urn:slock:grant-type:agent_request", request_id: requestId }), fetchImpl);
}

export async function fetchUserinfo(config: RaftOAuthConfig, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
	const res = await fetchImpl(`${config.apiOrigin}/api/oauth/userinfo`, {
		headers: { Authorization: `Bearer ${accessToken}` },
		cache: "no-store",
	});
	if (!res.ok) throw new RaftAuthError("RAFT_USERINFO_FAILED", "userinfo_failed");
	const userinfo = await res.json().catch(() => null);
	if (!isRecord(userinfo)) throw new RaftAuthError("RAFT_USERINFO_MALFORMED", "userinfo_malformed");
	return userinfo;
}

/**
 * Validate userinfo into a principal. Trusts ONLY sub/type/server_id/client_id;
 * carries preferred_username as a display/handle hint (mutable — the claim
 * anti-squat treats it as v0 handle; hardening anchors to sub as a fast-follow).
 * Enforces the botiverse-only server allow-list + client_id match here.
 */
export function validateRaftPrincipal(userinfo: unknown, config: RaftOAuthConfig): RaftPrincipal {
	if (!isRecord(userinfo)) throw new RaftAuthError("RAFT_USERINFO_MALFORMED", "userinfo_malformed");
	const sub = str(userinfo, "sub");
	const type = str(userinfo, "type");
	const serverId = str(userinfo, "server_id");
	const clientId = str(userinfo, "client_id");
	if (!sub || !type || !serverId || !clientId) throw new RaftAuthError("RAFT_USERINFO_MALFORMED", "userinfo_malformed");
	if (type !== "agent" && type !== "human") throw new RaftAuthError("RAFT_PRINCIPAL_TYPE_INVALID", "principal_type_invalid");
	// botiverse-only: server_id must be allow-listed. Login-time gate ONLY (once,
	// here) — a sealed session is itself proof the server was allowed, so the
	// per-request middleware trusts the owner and does NOT re-check. Uses the
	// shared serverAllowed from lib/auth (single source of truth).
	if (!serverAllowed(serverId, config.allowedServerIds as string[])) {
		throw new RaftAuthError("RAFT_SERVER_NOT_ALLOWED", "server_not_allowed");
	}
	// The token was issued to OUR app; the presented client_id must match the key we authenticate as.
	if (clientId !== config.clientKey) throw new RaftAuthError("RAFT_CLIENT_NOT_ALLOWED", "client_not_allowed");
	return {
		sub,
		type,
		serverId,
		clientId,
		preferredUsername: str(userinfo, "preferred_username"),
		name: str(userinfo, "name"),
	};
}

/** Owner id from a validated principal: `raft:${server_id}:${type}:${sub}` (matches lib/auth.ts ownerFromRaftUserinfo). */
export function ownerFromPrincipal(p: RaftPrincipal): string {
	return `raft:${p.serverId}:${p.type}:${p.sub}`;
}

/** The login-with-raft setup URL (browser flow). client_id = PUBLIC clientKey (PR #66). */
export function raftSetupUrl(config: RaftOAuthConfig, callbackUrl: string, state: string): string {
	const url = new URL("/login-with-raft/setup", config.appOrigin);
	url.searchParams.set("client_id", config.clientKey);
	url.searchParams.set("return_to", callbackUrl);
	url.searchParams.set("scope", "openid profile identity");
	url.searchParams.set("state", state);
	return url.toString();
}

/**
 * Discriminate between browser (human authorization_code) and agent (CLI agent_request) callback flows.
 * Browser flow requires an active login-state cookie from /auth/raft/login (expectedState !== null).
 * Agent flow has no login-state cookie, and tolerates legacy CLI requests that include an extraneous `state` query param.
 */
export function isBrowserCallbackFlow(expectedState: string | null): boolean {
	return expectedState !== null;
}
