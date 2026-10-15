// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { mailboxStub } from "./lib/mailboxRef";
import { releaseStoredBytes, reserveStoredBytes, type StorageAdmission } from "./lib/storageQuota";

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
	 * Returns `{ ok:false }` (without adding) when the plan limit is reached.
	 * Once storage is seeded, a mailbox adopted with mail already in it adds
	 * those bytes. Before the seed, the scan picks the mailbox up from the map. */
	async reserve(
		owner: string,
		email: string,
		name: string,
		limit: number,
	): Promise<{ ok: boolean; owned: number }> {
		await this.ensureSeed(owner);
		const seeded = Boolean(await this.ctx.storage.get("storage:seeded"));
		const incoming = seeded ? await this.mailboxUsage(email) : 0;
		return this.ctx.storage.transaction(async (tx) => {
			const map = (await tx.get<Record<string, string>>("mailboxes")) ?? {};
			if (email in map) return { ok: true, owned: Object.keys(map).length };
			if (Object.keys(map).length >= limit) return { ok: false, owned: Object.keys(map).length };
			map[email] = name || email;
			await tx.put("mailboxes", map);
			if (await tx.get("storage:seeded")) {
				const baseline = (await tx.get<Record<string, number>>("storage:baseline")) ?? {};
				if (!(email in baseline)) {
					const used = Number((await tx.get<number>("storage:used")) ?? 0);
					await tx.put("storage:used", used + incoming);
					baseline[email] = incoming;
					await tx.put("storage:baseline", baseline);
				}
			}
			return { ok: true, owned: Object.keys(map).length };
		});
	}

	/** Release a slot (e.g. mailbox deleted). Idempotent.
	 * Mail and attachments stay in the mailbox Durable Object, so the byte
	 * counter and the per-mailbox baseline stay too. Re-claiming the same
	 * address does not add those bytes again. A different address still pays
	 * for whatever is already stored in it. */
	async release(owner: string, email: string): Promise<{ owned: number }> {
		await this.ensureSeed(owner);
		return this.ctx.storage.transaction(async (tx) => {
			const map = (await tx.get<Record<string, string>>("mailboxes")) ?? {};
			if (!(email in map)) return { owned: Object.keys(map).length };
			delete map[email];
			await tx.put("mailboxes", map);
			return { owned: Object.keys(map).length };
		});
	}

	private addressesFor(owner: string, map: Record<string, string>): string[] {
		const emails = Object.keys(map);
		if (owner.startsWith("mailbox:")) {
			const address = owner.slice("mailbox:".length);
			if (address && !emails.includes(address)) emails.push(address);
		}
		return emails;
	}

	private async mailboxUsage(email: string): Promise<number> {
		return Number(await mailboxStub(this.env, email).usageBytes()) || 0;
	}

	/** List owned mailboxes with display names (strongly consistent). */
	async list(owner: string): Promise<Array<{ email: string; name: string }>> {
		const map = await this.ensureSeed(owner);
		return Object.entries(map).map(([email, name]) => ({ email, name }));
	}

	/** Last plan seen on an authenticated request. Missing stays free. */
	async rememberPlan(plan: "free" | "pro"): Promise<void> {
		const current = await this.ctx.storage.get<string>("storage:plan");
		if (current === plan) return;
		await this.ctx.storage.put("storage:plan", plan);
	}

	async plan(): Promise<"free" | "pro"> {
		return (await this.ctx.storage.get<string>("storage:plan")) === "pro" ? "pro" : "free";
	}

	/**
	 * Sum stored bytes for this owner. Runs once. A mailbox added while the
	 * scan is in flight forces a retry so the committed total matches the
	 * registry. A later scan must not overwrite a counter that reservations
	 * have already moved.
	 *
	 * "joined" means this call started before the snapshot existed and another
	 * call committed one while we were scanning. That snapshot already reflects
	 * the deletes that raced it, so the caller must not subtract again.
	 */
	private async ensureUsage(owner: string): Promise<"seeded" | "already" | "joined"> {
		if (await this.ctx.storage.get("storage:seeded")) return "already";
		for (let attempt = 0; attempt < 5; attempt++) {
			if (await this.ctx.storage.get("storage:seeded")) return "joined";
			const map = await this.ensureSeed(owner);
			const emails = this.addressesFor(owner, map);
			let total = 0;
			const baseline: Record<string, number> = {};
			for (const email of emails) {
				const bytes = await this.mailboxUsage(email);
				baseline[email] = bytes;
				total += bytes;
			}
			let outcome: "wrote" | "joined" | "stale" = "stale";
			await this.ctx.storage.transaction(async (tx) => {
				// Transactions can retry. Drop a verdict from a rolled-back attempt.
				outcome = "stale";
				if (await tx.get("storage:seeded")) {
					outcome = "joined";
					return;
				}
				const current = (await tx.get<Record<string, string>>("mailboxes")) ?? map;
				for (const email of this.addressesFor(owner, current)) {
					if (!(email in baseline)) {
						outcome = "stale";
						return;
					}
				}
				await tx.put("storage:used", total);
				await tx.put("storage:baseline", baseline);
				await tx.put("storage:seeded", true);
				outcome = "wrote";
			});
			if (outcome === "stale") continue;
			return outcome === "wrote" ? "seeded" : "joined";
		}
		throw new Error("storage seed did not converge");
	}

	/** Reserve `bytes` against the account cap. Does not delete existing mail. */
	async reserveStorage(owner: string, bytes: number, limit: number): Promise<StorageAdmission> {
		await this.sweepOrphans();
		await this.ensureUsage(owner);
		return reserveStoredBytes(this.ctx.storage, bytes, limit);
	}

	/**
	 * Return bytes after a user delete. Existing mail is never removed here.
	 * A snapshot taken by this call, or by another call that raced it before
	 * the snapshot existed, already excludes rows deleted ahead of the scan.
	 * Subtracting on top of that snapshot would credit the same bytes twice.
	 * A release that starts after the snapshot exists subtracts exactly once.
	 */
	async releaseStorage(owner: string, bytes: number): Promise<{ used: number }> {
		await this.sweepOrphans();
		const boot = await this.ensureUsage(owner);
		if (boot === "seeded" || boot === "joined") {
			return { used: Number((await this.ctx.storage.get<number>("storage:used")) ?? 0) };
		}
		return releaseStoredBytes(this.ctx.storage, bytes);
	}

	/** Remember object keys whose bytes stayed charged because delete was not confirmed. */
	async retainOrphans(keys: string[], bytes: number): Promise<void> {
		if (keys.length === 0 || bytes <= 0) return;
		const pending = (await this.ctx.storage.get<Array<{ keys: string[]; bytes: number }>>("storage:orphans")) ?? [];
		pending.push({ keys, bytes });
		await this.ctx.storage.put("storage:orphans", pending);
	}

	/** Retry orphan deletes. A confirmed delete refunds those bytes once. */
	private async sweepOrphans(): Promise<void> {
		const bucket = this.env.BUCKET;
		if (!bucket) return;
		const pending = (await this.ctx.storage.get<Array<{ keys: string[]; bytes: number }>>("storage:orphans")) ?? [];
		if (pending.length === 0) return;
		const remain: Array<{ keys: string[]; bytes: number }> = [];
		let refund = 0;
		for (const item of pending) {
			try {
				await bucket.delete(item.keys);
				refund += item.bytes;
			} catch {
				remain.push(item);
			}
		}
		await this.ctx.storage.put("storage:orphans", remain);
		if (refund > 0 && (await this.ctx.storage.get("storage:seeded"))) {
			await releaseStoredBytes(this.ctx.storage, refund);
		}
	}
}
