// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Access-key registry backed by Cloudflare KV (`AGENTIC_INBOX_KEYS`).
 *
 * Keys are stored HASHED (`sha256(token)` → record); the raw token is only ever
 * returned once, at mint. A key's `scope` is a single mailbox id (default,
 * finest isolation), the string "account" (all the owner's mailboxes), or
 * "admin" (all). See workers/lib/auth.ts for the access-decision logic.
 *
 * KV is eventually consistent (~60s global): a freshly-minted key may 401
 * briefly at some edges, and a revoked key may still authenticate for up to
 * ~60s. Revoke is therefore soft-disable, ≤~60s to propagate (documented, 2a).
 */
import type { AccessKeyRecord } from "./auth";
import { hashApiKey } from "./auth";

/** Stored form of a key record (adds lifecycle metadata to AccessKeyRecord). */
export interface StoredKeyRecord extends AccessKeyRecord {
	label?: string;
	createdAt: string; // ISO
	disabled?: boolean;
}

const keyKV = (env: { AGENTIC_INBOX_KEYS?: KVNamespace }): KVNamespace | undefined =>
	env.AGENTIC_INBOX_KEYS;

/** Resolve a presented Bearer token to its live (non-disabled) record, or null. */
export async function resolveKey(
	env: { AGENTIC_INBOX_KEYS?: KVNamespace },
	rawToken: string,
): Promise<AccessKeyRecord | null> {
	const kv = keyKV(env);
	if (!kv || !rawToken) return null;
	const hash = await hashApiKey(rawToken);
	const rec = await kv.get<StoredKeyRecord>(`key:${hash}`, "json");
	if (!rec || rec.disabled) return null;
	return { owner: rec.owner, scope: rec.scope };
}

/**
 * Mint a new key for `owner` with `scope`. Returns the RAW token (shown once).
 * `newToken` is injected so callers control token generation (and tests are
 * deterministic); in the worker use `mintToken()`.
 */
export async function mintKey(
	env: { AGENTIC_INBOX_KEYS?: KVNamespace },
	params: { owner: string; scope: string; label?: string; token: string; now: string },
): Promise<{ token: string; hash: string }> {
	const kv = keyKV(env);
	if (!kv) throw new Error("AGENTIC_INBOX_KEYS KV binding is not configured");
	const hash = await hashApiKey(params.token);
	const rec: StoredKeyRecord = {
		owner: params.owner,
		scope: params.scope,
		label: params.label,
		createdAt: params.now,
	};
	await kv.put(`key:${hash}`, JSON.stringify(rec));
	// Secondary index so an owner can list/revoke their keys.
	await kv.put(`owner:${params.owner}:${hash}`, "1");
	return { token: params.token, hash };
}

/** Soft-disable a key by hash (revoke). Takes ≤~60s to propagate (KV). */
export async function revokeKey(
	env: { AGENTIC_INBOX_KEYS?: KVNamespace },
	hash: string,
): Promise<boolean> {
	const kv = keyKV(env);
	if (!kv) return false;
	const rec = await kv.get<StoredKeyRecord>(`key:${hash}`, "json");
	if (!rec) return false;
	await kv.put(`key:${hash}`, JSON.stringify({ ...rec, disabled: true }));
	return true;
}

/** Record that `owner` holds `email` (per-owner mailbox index, for quota counts). */
export async function recordOwnedMailbox(
	env: { AGENTIC_INBOX_KEYS?: KVNamespace },
	owner: string,
	email: string,
): Promise<void> {
	const kv = keyKV(env);
	if (!kv) return;
	await kv.put(`mbox:${owner}:${email}`, "1");
}

/** Count mailboxes owned by `owner` (from the per-owner index). */
export async function countOwnedMailboxes(
	env: { AGENTIC_INBOX_KEYS?: KVNamespace },
	owner: string,
): Promise<number> {
	const kv = keyKV(env);
	if (!kv) return 0;
	let count = 0;
	let cursor: string | undefined;
	do {
		const res = await kv.list({ prefix: `mbox:${owner}:`, cursor });
		count += res.keys.length;
		cursor = res.list_complete ? undefined : res.cursor;
	} while (cursor);
	return count;
}

/** Generate a fresh opaque token (worker runtime). Format: `aibx_<hex>`. */
export function mintToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
	return `aibx_${hex}`;
}
