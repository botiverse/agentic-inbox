// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Login-with-Raft session cookie (AES-GCM sealed) + CSRF login-state cookie.
 *
 * Ported from me.build's battle-tested session layer (same crypto shape) with
 * an agentic-inbox cookie name. The sealed session carries the validated Raft
 * principal; the auth middleware (workers/app.ts) opens it and derives
 * `authOwner` (raft:${server_id}:${type}:${sub}), `authScope="account"`, and
 * `authHandle` (preferred_username, for the claim anti-squat namespace check).
 *
 * Secret: RAFT_SESSION_SECRET (wrangler secret). Never logged or sent to the
 * browser. Cookies are HttpOnly + SameSite=Lax + Secure (on https).
 */

/** Validated Raft principal (from validateRaftPrincipal). */
export interface RaftPrincipal {
	sub: string;
	type: "agent" | "human";
	serverId: string;
	clientId: string;
	preferredUsername: string | null;
	name: string | null;
}

export interface SessionPayload {
	principal: RaftPrincipal;
	expiresAt: number; // epoch ms
}

const COOKIE_NAME = "agentic_inbox_session";
const LOGIN_STATE_COOKIE_NAME = "agentic_inbox_login_state";
const LOGIN_STATE_PATH = "/auth/raft/callback";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	// Allocate over a concrete ArrayBuffer (not ArrayBufferLike) so the result is a
	// valid BufferSource for crypto.subtle.decrypt (avoids the SharedArrayBuffer union).
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

async function sessionKey(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
	return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Seal a session payload into an AES-GCM `iv.ciphertext` token. */
export async function sealSession(payload: SessionPayload, secret: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await sessionKey(secret),
		encoder.encode(JSON.stringify(payload)),
	);
	return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

/** Open + validate the session cookie on a request. Returns null if absent/invalid/expired. */
export async function openSession(request: Request, secret: string): Promise<SessionPayload | null> {
	const match = (request.headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
	if (!match) return null;
	const [rawIv, rawCiphertext] = decodeURIComponent(match[1]).split(".");
	if (!rawIv || !rawCiphertext) return null;
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: base64UrlDecode(rawIv) },
			await sessionKey(secret),
			base64UrlDecode(rawCiphertext),
		);
		const payload = JSON.parse(decoder.decode(plaintext)) as SessionPayload;
		if (!payload || typeof payload.expiresAt !== "number" || payload.expiresAt <= Date.now()) return null;
		const p = payload.principal;
		// Re-validate the sealed principal shape (defense in depth; a tampered or
		// truncated payload must not yield a half-formed identity).
		if (!p || (p.type !== "agent" && p.type !== "human") || !p.sub || !p.serverId || !p.clientId) return null;
		return payload;
	} catch {
		return null;
	}
}

function cookieSecurity(request: Request): string {
	return new URL(request.url).protocol === "https:" ? "; Secure" : "";
}

/** Set-Cookie for the session. `path` must be absolute. */
export function sessionCookie(request: Request, value: string, maxAgeSeconds: number, path = "/"): string {
	if (!path.startsWith("/")) throw new Error("Session cookie path must be absolute");
	return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${cookieSecurity(request)}`;
}

/** Clear the session cookie (logout). */
export function clearSessionCookie(request: Request, path = "/"): string {
	if (!path.startsWith("/")) throw new Error("Session cookie path must be absolute");
	return `${COOKIE_NAME}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(request)}`;
}

// ── CSRF login-state (scoped to the callback path) ─────────────────

/** Fresh 32-byte login state (base64url, 43 chars). */
export function newLoginState(): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function loginStateCookie(request: Request, value: string, maxAgeSeconds: number): string {
	return `${LOGIN_STATE_COOKIE_NAME}=${encodeURIComponent(value)}; Path=${LOGIN_STATE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${cookieSecurity(request)}`;
}

export function clearLoginStateCookie(request: Request): string {
	return `${LOGIN_STATE_COOKIE_NAME}=; Path=${LOGIN_STATE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(request)}`;
}

export function readLoginState(request: Request): string | null {
	const match = (request.headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${LOGIN_STATE_COOKIE_NAME}=([^;]+)`));
	return match ? decodeURIComponent(match[1]) : null;
}

/** Constant-time compare of two 43-char base64url login-state values. */
export async function loginStatesMatch(presented: string, expected: string): Promise<boolean> {
	if (!/^[A-Za-z0-9_-]{43}$/.test(presented) || !/^[A-Za-z0-9_-]{43}$/.test(expected)) return false;
	const [pd, ed] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(presented)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	const left = new Uint8Array(pd);
	const right = new Uint8Array(ed);
	let diff = 0;
	for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
	return diff === 0;
}
