// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { mailboxStub } from "./lib/mailboxRef";
import { reserveDailySend } from "./lib/sendPolicy";
import type { StorageAdmission } from "./lib/storageQuota";

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

	/** Atomic account-wide send admission; independent of mailbox lifecycle. */
	async reserveSend(): Promise<{ ok: boolean; retryAt: number }> {
		return reserveDailySend(this.ctx.storage);
	}

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
	 * those bytes. An address released while its mail remains is already in
	 * the baseline or the retained map, so claiming it again does not add twice.
	 * Before the seed, the scan picks the mailbox up from the map. */
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
				const retained = (await tx.get<Record<string, RetainedRec | number>>(RETAINED_KEY)) ?? {};
				if (email in baseline || email in retained) {
					if (!(email in baseline)) baseline[email] = retainedTotal(asRetained(retained[email]));
					if (email in retained) {
						delete retained[email];
						await tx.put(RETAINED_KEY, retained);
					}
					await tx.put("storage:baseline", baseline);
				} else {
					const used = Number((await tx.get<number>("storage:used")) ?? 0);
					await tx.put("storage:used", used + incoming);
					baseline[email] = incoming;
					await tx.put("storage:baseline", baseline);
				}
			}
			return { ok: true, owned: Object.keys(map).length };
		});
	}

	/** Release a slot. Mail and attachments stay in the mailbox Durable Object.
	 * Seed the byte baseline while this address is still in the registry, then
	 * keep a retained record so a later init still counts those bytes. The
	 * counter is not reduced. Re-claiming the same address does not add them
	 * again. A different address still pays for whatever is already stored. */
	async release(owner: string, email: string): Promise<{ owned: number }> {
		await this.ensureSeed(owner);
		await this.ensureUsage(owner);
		const live = await this.mailboxUsage(email);
		return this.ctx.storage.transaction(async (tx) => {
			const map = (await tx.get<Record<string, string>>("mailboxes")) ?? {};
			if (!(email in map)) return { owned: Object.keys(map).length };
			const baseline = (await tx.get<Record<string, number>>("storage:baseline")) ?? {};
			const holds = (await tx.get<Record<string, number>>(HOLDS_KEY)) ?? {};
			const retained = (await tx.get<Record<string, RetainedRec | number>>(RETAINED_KEY)) ?? {};
			// The snapshot is the bytes visible now, plus writes already reserved.
			// Commit folds those writes into the snapshot; cancel drops them.
			retained[email] = { bytes: live, pending: { ...holds } };
			if (!(email in baseline)) baseline[email] = live + sumValues(holds);
			delete map[email];
			await tx.put("mailboxes", map);
			await tx.put("storage:baseline", baseline);
			await tx.put(RETAINED_KEY, retained);
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
			const retained = (await this.ctx.storage.get<Record<string, RetainedRec | number>>(RETAINED_KEY)) ?? {};
			for (const [email, value] of Object.entries(retained)) {
				if (!(email in baseline)) {
					const bytes = retainedTotal(asRetained(value));
					baseline[email] = bytes;
					total += bytes;
				}
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
				const retainedNow = (await tx.get<Record<string, number>>(RETAINED_KEY)) ?? {};
				for (const email of Object.keys(retainedNow)) {
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

	/** Stored counter. Holds are already inside it. An open delete is not. */
	private async reported(tx: StorageTx): Promise<number> {
		return Number((await tx.get<number>("storage:used")) ?? 0);
	}

	/** Move a reserved write into a retained snapshot, or drop it if the reserve was cancelled. */
	private async settleRetainedHold(tx: StorageTx, id: string, commit: boolean): Promise<void> {
		const retained = (await tx.get<Record<string, RetainedRec | number>>(RETAINED_KEY)) ?? {};
		let changed = false;
		for (const [email, value] of Object.entries(retained)) {
			const rec = asRetained(value);
			if (!(id in rec.pending)) continue;
			if (commit) rec.bytes += Math.max(0, Math.floor(rec.pending[id] ?? 0));
			delete rec.pending[id];
			retained[email] = rec;
			changed = true;
		}
		if (changed) await tx.put(RETAINED_KEY, retained);
	}

	/**
	 * Reserve `bytes` for one write. The returned id is the only handle that can cancel it.
	 * `deleteId`, when set, may spend that one prepared delete and no other writer can.
	 * The first open for a row owns the allowance; a second open for the same row does not.
	 */
	async reserveStorage(owner: string, bytes: number, limit: number, deleteId?: string, rowKey?: string): Promise<StorageAdmission> {
		await this.sweepOrphans();
		await this.ensureUsage(owner);
		const add = Math.max(0, Math.floor(bytes));
		const id = crypto.randomUUID();
		return this.ctx.storage.transaction(async (tx) => {
			const used = await this.reported(tx);
			if (add <= 0) return { ok: true, used, limit };
			const holds = (await tx.get<Record<string, number>>(HOLDS_KEY)) ?? {};
			const deletes = (await tx.get<Record<string, DeleteRec>>(DELETES_KEY)) ?? {};
			// The counter is the charge. It drops only when the operation that owns
			// those bytes confirms reclamation: completeStorageDelete, or an orphan
			// sweep after R2 delete succeeds. An open delete is not that confirmation,
			// and neither is a mailbox scan that no longer sees a row.
			const visible = used;
			const prepared = deleteId ? asDelete(deletes[deleteId]) : null;
			const exclusive = prepared && !prepared.claimed && prepared.credit > 0 ? prepared.credit : 0;
			if (visible - exclusive + add > limit) return { ok: false, used, limit };
			holds[id] = add;
			await tx.put(HOLDS_KEY, holds);
			await tx.put("storage:used", used + add);
			if (rowKey) {
				// This hold and a later delete of the same row share one charge.
				// A new reserve for the row replaces an older unsettled link.
				const holdRows = (await tx.get<Record<string, string>>(HOLD_ROWS_KEY)) ?? {};
				holdRows[id] = rowKey;
				await tx.put(HOLD_ROWS_KEY, holdRows);
				const charges = (await tx.get<Record<string, RowCharge>>(ROW_CHARGES_KEY)) ?? {};
				charges[rowKey] = { holdId: id, refunded: false };
				await tx.put(ROW_CHARGES_KEY, charges);
			}
			if (prepared && exclusive > 0 && deleteId) {
				deletes[deleteId] = { ...prepared, claimed: true };
				await tx.put(DELETES_KEY, deletes);
			}
			return { ok: true, used: used + add, limit, id };
		});
	}

	/** Drop one uncommitted reservation. A missing id has already been cancelled or committed. */
	async cancelStorage(owner: string, id: string): Promise<{ used: number }> {
		if (!id) return { used: await this.reported(this.ctx.storage) };
		await this.sweepOrphans();
		await this.ensureUsage(owner);
		return this.ctx.storage.transaction(async (tx) => {
			const holds = (await tx.get<Record<string, number>>(HOLDS_KEY)) ?? {};
			if (id in holds) {
				const credit = Math.max(0, Math.floor(holds[id] ?? 0));
				delete holds[id];
				await tx.put(HOLDS_KEY, holds);
				await this.settleRetainedHold(tx, id, false);
				// A delete of this row may already have returned the charge. The hold
				// id is then gone or marked, and cancelling it must not subtract again.
				const already = await this.markRowCharge(tx, id, true);
				if (!already) {
					const used = Number((await tx.get<number>("storage:used")) ?? 0);
					const next = Math.max(0, used - credit);
					if (next !== used) await tx.put("storage:used", next);
				}
			}
			return { used: await this.reported(tx) };
		});
	}

	/** The write landed. The id can no longer be cancelled; the bytes stay on the counter. */
	async commitStorage(owner: string, id: string): Promise<{ used: number }> {
		if (!id) return { used: await this.reported(this.ctx.storage) };
		await this.sweepOrphans();
		await this.ensureUsage(owner);
		return this.ctx.storage.transaction(async (tx) => {
			const holds = (await tx.get<Record<string, number>>(HOLDS_KEY)) ?? {};
			if (id in holds) {
				delete holds[id];
				await tx.put(HOLDS_KEY, holds);
				await this.settleRetainedHold(tx, id, true);
				// The row is stored and still charged. Drop the link so a later
				// user delete of this row can refund exactly once.
				await this.clearUnrefundedCharge(tx, id);
			}
			return { used: await this.reported(tx) };
		});
	}

	/**
	 * Name the bytes a delete will return. Call this before the row or objects are removed.
	 * The record does not change the counter and does not free space for other writes.
	 * `rowKey` binds the exclusive replacement allowance to one row; a second open for
	 * that row keeps its own refund amount but cannot spend the allowance again.
	 * A record left behind by a killed request still does not reduce admission.
	 */
	async openStorageDelete(owner: string, bytes: number, rowKey?: string): Promise<{ id: string; used: number }> {
		await this.sweepOrphans();
		await this.ensureUsage(owner);
		const amount = Math.max(0, Math.floor(bytes));
		if (amount <= 0) return { id: "", used: await this.reported(this.ctx.storage) };
		const id = crypto.randomUUID();
		return this.ctx.storage.transaction(async (tx) => {
			const deletes = (await tx.get<Record<string, DeleteRec>>(DELETES_KEY)) ?? {};
			const rowTaken = Boolean(
				rowKey && Object.values(deletes).some((value) => {
					const rec = asDelete(value);
					return rec?.row === rowKey && rec.credit > 0;
				}),
			);
			deletes[id] = { bytes: amount, credit: rowTaken ? 0 : amount, row: rowKey, claimed: false };
			await tx.put(DELETES_KEY, deletes);
			return { id, used: await this.reported(tx) };
		});
	}

	/** Credit one prepared delete. A second call finds the id gone and subtracts nothing.
	 * A delete whose refund was moved onto an orphan subtracts nothing too. */
	async completeStorageDelete(owner: string, id: string): Promise<{ used: number }> {
		if (!id) return { used: await this.reported(this.ctx.storage) };
		await this.sweepOrphans();
		await this.ensureUsage(owner);
		return this.ctx.storage.transaction(async (tx) => {
			const deletes = (await tx.get<Record<string, DeleteRec>>(DELETES_KEY)) ?? {};
			const rec = asDelete(deletes[id]);
			if (rec) {
				delete deletes[id];
				await tx.put(DELETES_KEY, deletes);
				// The create hold for this row is the same charge. Retire it here
				// without a second subtract, and remember that the charge is returned
				// so a later cancel of that hold cannot subtract either.
				const already = rec.row ? await this.retireRowHold(tx, rec.row) : false;
				// orphanId means retainOrphans already owns this refund.
				const credit = rec.orphanId || already ? 0 : Math.max(0, Math.floor(rec.bytes));
				const used = Number((await tx.get<number>("storage:used")) ?? 0);
				const next = Math.max(0, used - credit);
				if (next !== used) await tx.put("storage:used", next);
			}
			return { used: await this.reported(tx) };
		});
	}

	/** The delete did not happen. Drop its record without touching the counter. */
	async abortStorageDelete(owner: string, id: string): Promise<{ used: number }> {
		if (!id) return { used: await this.reported(this.ctx.storage) };
		return this.ctx.storage.transaction(async (tx) => {
			const deletes = (await tx.get<Record<string, DeleteRec>>(DELETES_KEY)) ?? {};
			if (id in deletes) {
				delete deletes[id];
				await tx.put(DELETES_KEY, deletes);
			}
			return { used: await this.reported(tx) };
		});
	}

	/** Remember object keys whose bytes stayed charged because delete was not confirmed.
	 * `holdId`, when set, is retired here so only this orphan record can credit those bytes.
	 * `deleteId`, when set, moves that delete's refund onto this orphan in the same
	 * transaction, and retires the row's original create hold without subtracting.
	 * The orphan owns the only refund. Cancelling the hold or completing the delete
	 * after that, before or after the sweep, must not subtract. A repeat call for
	 * the same delete id appends nothing. */
	async retainOrphans(keys: string[], bytes: number, holdId?: string, deleteId?: string): Promise<void> {
		if (keys.length === 0 || bytes <= 0) return;
		const record: OrphanRecord = { id: crypto.randomUUID(), keys, bytes: Math.floor(bytes) };
		await this.ctx.storage.transaction(async (tx) => {
			if (holdId) {
				const holds = (await tx.get<Record<string, number>>(HOLDS_KEY)) ?? {};
				if (holdId in holds) {
					delete holds[holdId];
					await tx.put(HOLDS_KEY, holds);
					await this.settleRetainedHold(tx, holdId, false);
				}
			}
			const pending = (await tx.get<OrphanRecord[]>("storage:orphans")) ?? [];
			if (deleteId) {
				if (pending.some((row) => row.deleteId === deleteId)) return;
				const deletes = (await tx.get<Record<string, DeleteRec>>(DELETES_KEY)) ?? {};
				const rec = asDelete(deletes[deleteId]);
				// Already moved, or the id was aborted or completed. Do not open a second refund.
				if (rec?.orphanId || !rec) return;
				const credit = Math.max(0, Math.floor(rec.bytes));
				deletes[deleteId] = { ...rec, bytes: 0, credit: 0, claimed: true, orphanId: record.id };
				await tx.put(DELETES_KEY, deletes);
				if (credit <= 0) return;
				record.bytes = credit;
				record.deleteId = deleteId;
				// The create hold is the same charge. Retire it here, with no counter
				// change. Only the orphan sweep subtracts, once R2 delete succeeds.
				if (rec.row) await this.retireRowHold(tx, rec.row);
			}
			pending.push(record);
			await tx.put("storage:orphans", pending);
		});
	}

	/**
	 * Retry orphan deletes. R2 delete may run twice; the credit runs once.
	 * The record is removed in the same transaction as its refund, matched by id,
	 * so a second sweeper cannot refund it and an append during the delete is kept.
	 */
	/** Remember that `holdId`'s row charge was refunded. Returns true when a delete already did. */
	private async markRowCharge(tx: StorageTx, holdId: string, refunded: boolean): Promise<boolean> {
		const holdRows = (await tx.get<Record<string, string>>(HOLD_ROWS_KEY)) ?? {};
		const rowKey = holdRows[holdId];
		if (!rowKey) return false;
		delete holdRows[holdId];
		await tx.put(HOLD_ROWS_KEY, holdRows);
		const charges = (await tx.get<Record<string, RowCharge>>(ROW_CHARGES_KEY)) ?? {};
		const charge = charges[rowKey];
		if (!charge || charge.holdId !== holdId) return false;
		const already = Boolean(charge.refunded);
		charges[rowKey] = { holdId, refunded };
		await tx.put(ROW_CHARGES_KEY, charges);
		return already;
	}

	/** The write was committed. This hold no longer shares a refund with a future delete. */
	private async clearUnrefundedCharge(tx: StorageTx, holdId: string): Promise<void> {
		const holdRows = (await tx.get<Record<string, string>>(HOLD_ROWS_KEY)) ?? {};
		const rowKey = holdRows[holdId];
		if (!rowKey) return;
		delete holdRows[holdId];
		await tx.put(HOLD_ROWS_KEY, holdRows);
		const charges = (await tx.get<Record<string, RowCharge>>(ROW_CHARGES_KEY)) ?? {};
		const charge = charges[rowKey];
		if (!charge || charge.holdId !== holdId || charge.refunded) return;
		delete charges[rowKey];
		await tx.put(ROW_CHARGES_KEY, charges);
	}

	/** A delete is settling this row. Retire its create hold and report whether the charge was already returned. */
	private async retireRowHold(tx: StorageTx, rowKey: string): Promise<boolean> {
		const charges = (await tx.get<Record<string, RowCharge>>(ROW_CHARGES_KEY)) ?? {};
		const charge = charges[rowKey];
		if (!charge) return false;
		const already = Boolean(charge.refunded);
		if (charge.holdId) {
			const holds = (await tx.get<Record<string, number>>(HOLDS_KEY)) ?? {};
			if (charge.holdId in holds) {
				delete holds[charge.holdId];
				await tx.put(HOLDS_KEY, holds);
				await this.settleRetainedHold(tx, charge.holdId, false);
			}
			const holdRows = (await tx.get<Record<string, string>>(HOLD_ROWS_KEY)) ?? {};
			if (charge.holdId in holdRows) {
				delete holdRows[charge.holdId];
				await tx.put(HOLD_ROWS_KEY, holdRows);
			}
		}
		charges[rowKey] = { holdId: charge.holdId, refunded: true };
		await tx.put(ROW_CHARGES_KEY, charges);
		return already;
	}

	private async sweepOrphans(): Promise<void> {
		const bucket = this.env.BUCKET;
		if (!bucket) return;
		const pending = (await this.ctx.storage.get<OrphanRecord[]>("storage:orphans")) ?? [];
		if (pending.length === 0) return;
		for (const item of pending) {
			try {
				await bucket.delete(item.keys);
			} catch {
				continue;
			}
			const id = item.id || item.keys.join("\0");
			await this.ctx.storage.transaction(async (tx) => {
				if (!(await tx.get("storage:seeded"))) return;
				const current = (await tx.get<OrphanRecord[]>("storage:orphans")) ?? [];
				const idx = current.findIndex((row) => (row.id || row.keys.join("\0")) === id);
				if (idx < 0) return;
				const credit = Math.max(0, Math.floor(current[idx]?.bytes ?? 0));
				current.splice(idx, 1);
				await tx.put("storage:orphans", current);
				if (credit <= 0) return;
				const used = Number((await tx.get<number>("storage:used")) ?? 0);
				const next = Math.max(0, used - credit);
				if (next !== used) await tx.put("storage:used", next);
			});
		}
	}
}

const HOLDS_KEY = "storage:holds";
const HOLD_ROWS_KEY = "storage:holdRows";
const ROW_CHARGES_KEY = "storage:rowCharges";
const DELETES_KEY = "storage:deletes";
const RETAINED_KEY = "storage:retained";

type StorageTx = {
	get<T = unknown>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
};

type OrphanRecord = { id?: string; keys: string[]; bytes: number; deleteId?: string };

type DeleteRec = { bytes: number; credit: number; row?: string; claimed?: boolean; orphanId?: string };

/** One refund for a row, shared by the create hold and a later delete of that row. */
type RowCharge = { holdId: string; refunded: boolean };

type RetainedRec = { bytes: number; pending: Record<string, number> };

function asRetained(value: RetainedRec | number | undefined): RetainedRec {
	if (typeof value === "number") return { bytes: value, pending: {} };
	if (!value || typeof value !== "object") return { bytes: 0, pending: {} };
	return { bytes: Number(value.bytes) || 0, pending: value.pending ?? {} };
}

function retainedTotal(rec: RetainedRec): number {
	return rec.bytes + sumValues(rec.pending);
}

function asDelete(value: DeleteRec | number | undefined): DeleteRec | null {
	if (typeof value === "number") return { bytes: value, credit: value };
	if (!value || typeof value !== "object") return null;
	return value;
}

function sumValues(map: Record<string, number>): number {
	let total = 0;
	for (const value of Object.values(map)) total += Number(value) || 0;
	return total;
}
