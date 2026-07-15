// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-agent auth + mailbox ownership primitives (pure logic).
 *
 * Identity layer: API keys are stored hashed in KV (keyHash -> {accountId,...}).
 * Ownership layer: each mailbox carries an `owner` (an accountId); API access is
 * scoped to the owner. Receiving is NOT owner-gated. The `<handle>` and
 * `<handle>-*` local-part prefixes are reserved to the matching account to
 * prevent identity squatting.
 *
 * These functions are pure so they can be unit-tested without KV/bindings; the
 * registry lookups (does a key exist? is a handle owned by someone else?) are
 * performed by the caller and passed in as plain values.
 */

/** SHA-256 hex of a raw API key. Keys are only ever stored/compared hashed. */
export async function hashApiKey(raw: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Whether a caller may access (read/send/manage/delete) a mailbox.
 * Admins can access any mailbox; otherwise the caller must be the owner.
 * Note: this gates API access only — inbound delivery is never owner-gated.
 */
export function ownerCanAccess(
	callerAccountId: string | null | undefined,
	mailboxOwner: string | null | undefined,
	isAdmin: boolean,
): boolean {
	if (isAdmin) return true;
	if (!callerAccountId) return false;
	return mailboxOwner === callerAccountId;
}

/**
 * The handle that owns the `<handle>` / `<handle>-*` reserved prefix for a
 * local-part. e.g. "pai-onboard-daily-001" -> "pai", "gogo" -> "gogo".
 */
export function reservedHandleForLocalPart(localPart: string): string {
	return localPart.toLowerCase().split("-")[0] ?? "";
}

/** The reserved handle for a full address (local-part before "@"). */
export function reservedHandleForAddress(address: string): string {
	return reservedHandleForLocalPart(address.toLowerCase().split("@")[0] ?? "");
}

// ── 3-resource model: Owner / Mailbox / Access Key ────────────────
// (locked 2026-07-12) Ownership modeled by Owner; access credential scoped by
// resource. A key's scope is either a specific mailbox id, the whole account,
// or admin (all).

export type KeyScope = string; // a mailboxId, or "account", or "admin"

export interface AccessKeyRecord {
	owner: string; // e.g. raft:${server_id}:agent:${sub}, or local:admin
	scope: KeyScope;
}

export interface MailboxRef {
	id: string; // full email address, the resource key
	owner: string | null | undefined;
}

/**
 * Whether an access key authorizes an operation on a mailbox.
 * - `admin` scope → any mailbox.
 * - otherwise the caller must OWN the mailbox, AND
 *   - `account` scope → any mailbox the owner holds;
 *   - a mailbox-id scope → only that exact mailbox (finest isolation).
 */
export function mailboxAccessAllowed(key: AccessKeyRecord, mailbox: MailboxRef): boolean {
	if (key.scope === "admin") return true;
	if (!mailbox.owner || mailbox.owner !== key.owner) return false;
	if (key.scope === "account") return true;
	return key.scope === mailbox.id;
}

/**
 * Derive the canonical Owner id from Raft/Slock OAuth userinfo.
 * Trust ONLY type/sub/server_id (never preferred_username/name). Returns null
 * if the required claims are missing.
 */
export function ownerFromRaftUserinfo(
	userinfo: { type?: string; sub?: string; server_id?: string } | null | undefined,
): string | null {
	if (!userinfo?.type || !userinfo.sub || !userinfo.server_id) return null;
	return `raft:${userinfo.server_id}:${userinfo.type}:${userinfo.sub}`;
}

// ── Tiering / quota ────────────────────────────────────────────────
// Mechanism only; the numbers are a pricing/PM decision. free=1 is tygg's
// confirmed first rule (2026-07-13).

export interface PlanLimits {
	maxMailboxes: number;
}

// free = 1 mailbox; pro = up to 10 per agent (tygg 2026-07-14). The plan is
// typically derived from the raft server's tier (server_id), not the individual
// account — but this table only needs the plan name → limit mapping.
export const DEFAULT_PLAN_LIMITS: Record<string, PlanLimits> = {
	free: { maxMailboxes: 1 },
	pro: { maxMailboxes: 10 },
};

export function maxMailboxesForPlan(
	plan: string | null | undefined,
	limits: Record<string, PlanLimits> = DEFAULT_PLAN_LIMITS,
): number {
	return (limits[plan ?? "free"] ?? limits.free).maxMailboxes;
}

/** Extract the raft server_id from an owner id (`raft:<server_id>:<type>:<sub>`). */
export function serverIdFromOwner(owner: string | null | undefined): string | null {
	const m = (owner ?? "").match(/^raft:([^:]+):/);
	return m ? m[1] : null;
}

/**
 * Whether a raft server_id is allowed to sign in. When `allowedServerIds` is
 * empty, all servers are allowed (unrestricted); otherwise login is gated to the
 * listed servers (v0: botiverse-only — tygg 2026-07-15). Enforce in the OAuth
 * callback after userinfo.
 */
export function serverAllowed(serverId: string | null | undefined, allowedServerIds: string[]): boolean {
	if (allowedServerIds.length === 0) return true;
	return !!serverId && allowedServerIds.includes(serverId);
}

/**
 * Derive a plan for an owner. Tiering is at the raft-server level: an owner
 * whose server_id is in `proServerIds` is `pro`, otherwise `free`.
 * (free=1 mailbox, pro=10 — tygg 2026-07-14.)
 */
export function planForOwner(owner: string, proServerIds: string[]): "free" | "pro" {
	const sid = serverIdFromOwner(owner);
	return sid && proServerIds.includes(sid) ? "pro" : "free";
}

/** Whether an owner on `plan` may create another mailbox given their current count. */
export function canCreateMailbox(
	plan: string | null | undefined,
	currentOwnedCount: number,
	limits: Record<string, PlanLimits> = DEFAULT_PLAN_LIMITS,
): boolean {
	return currentOwnedCount < maxMailboxesForPlan(plan, limits);
}

// System local-parts that NO agent may claim (RFC 2142 + common infra names).
export const RESERVED_SYSTEM_LOCALPARTS = new Set([
	"admin", "administrator", "root", "postmaster", "hostmaster", "webmaster",
	"noreply", "no-reply", "mailer-daemon", "daemon", "abuse", "security",
	"support", "info", "help", "billing", "sales",
]);

export function isReservedSystemLocalPart(localPart: string): boolean {
	return RESERVED_SYSTEM_LOCALPARTS.has(localPart.toLowerCase());
}

/**
 * v0 claim rule (anti-squat): an authenticated caller may claim a mailbox only
 * within its OWN handle namespace (`<handle>@` or `<handle>-*`) and never a
 * reserved system name. Prevents agent A from squatting B's identity address.
 * `callerHandle` is the caller's raft `preferred_username`.
 * (Free / shared names outside your namespace are a fast-follow.)
 */
export function claimAllowedForHandle(localPart: string, callerHandle: string): boolean {
	const lp = localPart.toLowerCase();
	if (!callerHandle) return false;
	if (isReservedSystemLocalPart(lp)) return false;
	return reservedHandleForLocalPart(lp) === callerHandle.toLowerCase();
}

export type ClaimAction = "create" | "adopt" | "idempotent" | "taken";
/**
 * Decide what a claim on an address should do, given the mailbox's current
 * stored state. This is ONLY the ownership disposition — the namespace/anti-squat
 * gate (`claimAllowedForHandle`) is enforced separately and must pass first.
 * - not exists            → "create"  (fresh mailbox)
 * - exists, owner == you   → "idempotent" (re-claim your own; no new key)
 * - exists, owner == other → "taken" (409; belongs to someone else)
 * - exists, no owner       → "adopt" (ownerless orphan, e.g. admin-provisioned
 *   canonical `<handle>@` — take ownership instead of 409'ing)
 */
export function classifyClaim(
	exists: boolean,
	existingOwner: string | null | undefined,
	owner: string,
): ClaimAction {
	if (!exists) return "create";
	if (existingOwner && existingOwner === owner) return "idempotent";
	if (existingOwner) return "taken";
	return "adopt";
}

/**
 * Whether `callerHandle` may CREATE a mailbox with this local-part.
 * - Always allowed within the caller's own reserved prefix (`<caller>`/`<caller>-*`).
 * - Otherwise only if the reserved handle isn't already owned by another account
 *   (prevents squatting someone else's handle). `reservedByOtherAccount` is
 *   computed by the caller from the account registry.
 */
export function createAllowedByPrefix(
	localPart: string,
	callerHandle: string,
	reservedByOtherAccount: boolean,
): boolean {
	const reserved = reservedHandleForLocalPart(localPart);
	if (reserved === callerHandle.toLowerCase()) return true;
	return !reservedByOtherAccount;
}
