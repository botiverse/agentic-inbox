// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

/**
 * Per-owner mailbox registry. Addressed by `idFromName(owner)`, so one instance
 * per account. Durable Object storage is strongly consistent and a DO processes
 * one request at a time, so read-modify-write here is atomic — which is exactly
 * what quota enforcement needs.
 *
 * Why this exists: the previous quota check counted a KV `mbox:` index via
 * `kv.list`, which is eventually consistent (~<=60s). A second claim within that
 * window under-counted and slipped past the free=1 limit (dogfood: Cardy claimed
 * a 3rd mailbox on a free plan). Counting/reserving here removes that race and
 * also gives `list` a lag-free source of truth (dogfood: Box — list returned []
 * right after a claim).
 *
 * On first use per owner it seeds itself once from the legacy KV `mbox:` index
 * (pre-DO mailboxes), then is the sole authority.
 */
export class OwnerDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;

	/** One-time hydration from the legacy KV index so owners with pre-DO mailboxes
	 * keep their count. After this, the DO storage is authoritative. */
	private async ensureSeed(owner: string): Promise<Record<string, string>> {
		const existing = await this.ctx.storage.get<Record<string, string>>("mailboxes");
		if (existing) return existing;
		const map: Record<string, string> = {};
		const kv = this.env.AGENTIC_INBOX_KEYS;
		if (kv) {
			const prefix = `mbox:${owner}:`;
			let cursor: string | undefined;
			do {
				const res = await kv.list<{ name?: string }>({ prefix, cursor });
				for (const k of res.keys) {
					const email = k.name.slice(prefix.length);
					map[email] = k.metadata?.name || email;
				}
				cursor = res.list_complete ? undefined : res.cursor;
			} while (cursor);
		}
		await this.ctx.storage.put("mailboxes", map);
		return map;
	}

	/** Atomically reserve a slot for `email`. Idempotent if already owned.
	 * Returns `{ ok:false }` (without adding) when the plan limit is reached. */
	async reserve(
		owner: string,
		email: string,
		name: string,
		limit: number,
	): Promise<{ ok: boolean; owned: number }> {
		const map = await this.ensureSeed(owner);
		if (email in map) return { ok: true, owned: Object.keys(map).length };
		if (Object.keys(map).length >= limit) return { ok: false, owned: Object.keys(map).length };
		map[email] = name || email;
		await this.ctx.storage.put("mailboxes", map);
		return { ok: true, owned: Object.keys(map).length };
	}

	/** Release a slot (e.g. mailbox deleted). Idempotent. */
	async release(owner: string, email: string): Promise<{ owned: number }> {
		const map = await this.ensureSeed(owner);
		if (email in map) {
			delete map[email];
			await this.ctx.storage.put("mailboxes", map);
		}
		return { owned: Object.keys(map).length };
	}

	/** List owned mailboxes with display names (strongly consistent). */
	async list(owner: string): Promise<Array<{ email: string; name: string }>> {
		const map = await this.ensureSeed(owner);
		return Object.entries(map).map(([email, name]) => ({ email, name }));
	}
}
