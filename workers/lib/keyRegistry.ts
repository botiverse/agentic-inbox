// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-owner mailbox index in Cloudflare KV (`AGENTIC_INBOX_KEYS`).
 *
 * This is quota/list bookkeeping, not authentication. Login is Login with Raft.
 * The per-owner Durable Object is the count and list authority; these entries
 * are the legacy index kept in sync on claim and release.
 */

const keyKV = (env: { AGENTIC_INBOX_KEYS?: KVNamespace }): KVNamespace | undefined =>
	env.AGENTIC_INBOX_KEYS;

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
