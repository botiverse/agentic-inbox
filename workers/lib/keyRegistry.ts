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

/** Public metadata about a stored key — NEVER includes the raw token. */
export interface KeyMetadata {
	id: string; // the key hash — an opaque handle for list/revoke
	scope: string;
	label?: string;
	createdAt: string;
	disabled: boolean;
}

/** List an owner's keys (metadata only, no plaintext). Optionally filter by scope. */
export async function listOwnerKeys(
	env: { AGENTIC_INBOX_KEYS?: KVNamespace },
	owner: string,
	scope?: string,
): Promise<KeyMetadata[]> {
	const kv = keyKV(env);
	if (!kv) return [];
	const prefix = `owner:${owner}:`;
	const out: KeyMetadata[] = [];
	let cursor: string | undefined;
	do {
		const res = await kv.list({ prefix, cursor });
		for (const k of res.keys) {
			const hash = k.name.slice(prefix.length);
			const rec = await kv.get<StoredKeyRecord>(`key:${hash}`, "json");
			if (!rec) continue;
			if (scope && rec.scope !== scope) continue;
			out.push({ id: hash, scope: rec.scope, label: rec.label, createdAt: rec.createdAt, disabled: !!rec.disabled });
		}
		cursor = res.list_complete ? undefined : res.cursor;
	} while (cursor);
	return out;
}

/** Revoke a key by hash ONLY if it belongs to `owner` (owner-scoped DELETE).
 * Returns false if the key doesn't exist or isn't the owner's. */
export async function revokeOwnerKey(
	env: { AGENTIC_INBOX_KEYS?: KVNamespace },
	owner: string,
	hash: string,
): Promise<boolean> {
	const kv = keyKV(env);
	if (!kv) return false;
	const rec = await kv.get<StoredKeyRecord>(`key:${hash}`, "json");
	if (!rec || rec.owner !== owner) return false;
	return revokeKey(env, hash);
}

/** Rotate the key(s) for (owner, scope). Ordering is deliberate (Gogo's atomicity
 * bar): MINT the new key FIRST — so if minting fails the owner is never left
 * without a working key ("both invalid"/lockout) — THEN soft-disable the prior
 * live key(s) at that scope. A revoke failure only leaves a brief "both valid"
 * window (the owner's own keys; the next rotate cleans it up), never a lockout.
 * Ends with exactly one active key per scope. Returns the new raw token (once). */
export async function rotateKey(
	env: { AGENTIC_INBOX_KEYS?: KVNamespace },
	params: { owner: string; scope: string; token: string; label?: string; now: string },
): Promise<{ token: string; hash: string; revoked: number }> {
	const minted = await mintKey(env, params);
	const existing = await listOwnerKeys(env, params.owner, params.scope);
	let revoked = 0;
	for (const k of existing) {
		if (k.disabled || k.id === minted.hash) continue; // never revoke the one just minted
		if (await revokeKey(env, k.id)) revoked++;
	}
	return { ...minted, revoked };
}

/** Record that `owner` holds `email` (per-owner mailbox index, for quota counts).
 * The display name is stored as KV metadata so the list endpoint can return it
 * without an extra read per mailbox (dogfood: Maggie — list showed the address
 * instead of the claimed name). */
export async function recordOwnedMailbox(
	env: { AGENTIC_INBOX_KEYS?: KVNamespace },
	owner: string,
	email: string,
	name?: string,
): Promise<void> {
	const kv = keyKV(env);
	if (!kv) return;
	await kv.put(`mbox:${owner}:${email}`, "1", name ? { metadata: { name } } : undefined);
}

/** Remove `owner`'s index entry for `email` (mailbox released/deleted). */
export async function removeOwnedMailbox(
	env: { AGENTIC_INBOX_KEYS?: KVNamespace },
	owner: string,
	email: string,
): Promise<void> {
	const kv = keyKV(env);
	if (!kv) return;
	await kv.delete(`mbox:${owner}:${email}`);
}

/** List mailboxes owned by `owner` (from the index), with the display name
 * carried in KV metadata. `name` falls back to the address for pre-metadata rows. */
export async function listOwnedMailboxes(
	env: { AGENTIC_INBOX_KEYS?: KVNamespace },
	owner: string,
): Promise<Array<{ email: string; name: string }>> {
	const kv = keyKV(env);
	if (!kv) return [];
	const prefix = `mbox:${owner}:`;
	const mailboxes: Array<{ email: string; name: string }> = [];
	let cursor: string | undefined;
	do {
		const res = await kv.list<{ name?: string }>({ prefix, cursor });
		for (const k of res.keys) {
			const email = k.name.slice(prefix.length);
			mailboxes.push({ email, name: k.metadata?.name || email });
		}
		cursor = res.list_complete ? undefined : res.cursor;
	} while (cursor);
	return mailboxes;
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

/** Structured onboarding for a freshly-issued mailbox key — returned alongside
 * the raw token so we never hand out a bare credential with no context (the human
 * UI renders this; agents read it as fields). (dogfood: tygg/Bugen/Maggie.) */
export function keyGuidance(mailbox: string): {
	what: string;
	scope: string;
	how_to_use: string;
	save: string;
	rotate: string;
	revoke: string;
	not_needed_for: string;
} {
	return {
		what: `A mailbox-scoped API key for ${mailbox}. It authenticates direct HTTP (Bearer) access to this one mailbox.`,
		scope: `Only ${mailbox} — it cannot touch any other mailbox or account.`,
		how_to_use: "Send it as an HTTP header: `Authorization: Bearer <key>`.",
		save: "Shown ONCE and never recoverable — copy and store it securely now.",
		rotate: `Lost or leaked it? Rotate: POST /api/v1/mailboxes/${mailbox}/keys/rotate — invalidates this key and returns a new one.`,
		revoke: `Revoke: DELETE /api/v1/mailboxes/${mailbox}/keys/{id} (list ids via GET /api/v1/mailboxes/${mailbox}/keys).`,
		not_needed_for: "raft-native calls (`raft integration invoke`) authenticate via your stored session — you do NOT need this key for those.",
	};
}

/** Generate a fresh opaque token (worker runtime). Format: `aibx_<hex>`. */
export function mintToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
	return `aibx_${hex}`;
}
