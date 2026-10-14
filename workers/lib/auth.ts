// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-agent auth + mailbox ownership primitives (pure logic).
 *
 * Identity is a Login-with-Raft session. Each mailbox carries an `owner`
 * (an accountId); API access is scoped to that owner. Receiving is NOT
 * owner-gated. The `<handle>` and
 * `<handle>-*` local-part prefixes are reserved to the matching account to
 * prevent identity squatting.
 *
 * These functions are pure so they can be unit-tested without KV/bindings; the
 * caller passes ownership facts in as plain values.
 */

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

// ── Owner / Mailbox access ─────────────────────────────────────────
// Ownership modeled by Owner. A Raft session presents scope "account".
// scope "admin" or a single mailbox id stay in the decision function;
// the auth middleware does not issue them.

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
 * Whether this caller may operate on a mailbox.
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

/** Botiverse. Used only when Flagship cannot be evaluated, so a Flagship outage does not lock this server out. */
export const BOTIVERSE_SERVER_ID = "95f993fa-2a68-4797-b8ae-7beb7d984ada";

/** `plan_tier` from Raft serverinfo. Anything other than `free` is paid → pro. Missing or unknown → free. */
export function planFromServerTier(planTier: unknown): "free" | "pro" {
	return typeof planTier === "string" && planTier.length > 0 && planTier !== "free" ? "pro" : "free";
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
/** A valid ASCII email local-part (mail.build only issues ASCII addresses). */
export function isValidAsciiLocalPart(localPart: string): boolean {
	return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(localPart.toLowerCase());
}

/**
 * The ASCII namespace an owner may claim mailboxes under. An ASCII-usable handle
 * keeps its own name (unchanged behaviour). A handle containing ANY non-ASCII
 * char — which could never anchor an ASCII email local-part — would otherwise be
 * fully locked out of claiming (CJK addr → 400 Invalid email; ASCII addr → 403
 * NAMESPACE_FORBIDDEN, a whole class of agents with no path). Such handles get a
 * stable derived slug `a-<hash>` so they still have a claimable namespace.
 * Deterministic (sync FNV-1a over the UTF-8 bytes) — uniqueness is first-come at
 * claim time anyway, so the slug only needs to be stable + collision-unlikely.
 * (AX: 跳虎 fresh-agent dogfood — non-ASCII handle couldn't claim anything.)
 */
export function asciiNamespaceForHandle(handle: string): string {
	const h = (handle || "").toLowerCase();
	if (!h) return ""; // no handle → no claim path (caller enforces 403)
	if (isValidAsciiLocalPart(h)) return h;
	const bytes = new TextEncoder().encode(h);
	let hash = 0x811c9dc5;
	for (const b of bytes) {
		hash ^= b;
		hash = Math.imul(hash, 0x01000193);
	}
	return `a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function claimAllowedForHandle(localPart: string, callerHandle: string): boolean {
	const lp = localPart.toLowerCase();
	const ch = callerHandle.toLowerCase();
	if (!ch) return false;
	if (isReservedSystemLocalPart(lp)) return false;
	// Anchor to the caller's FULL handle: the claimable namespace is `<handle>@`
	// and `<handle>-*@`. The old check folded lp to its first hyphen-segment
	// (reservedHandleForLocalPart) and compared that to the whole handle — so any
	// caller whose handle ITSELF contains a hyphen (e.g. `gogo-signup-dogfood`,
	// folded to `gogo`) could never match and could claim NOTHING. Agents never hit
	// it (agent handles have no hyphen); found only on the human side (dogfood: Gogo).
	return lp === ch || lp.startsWith(`${ch}-`);
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

import type { FlagshipBinding } from "../types";

const FLAG_OVERRIDE = new Set(["TARGETING_MATCH", "SPLIT"]);

/**
 * Whether a raft server_id may sign in. Flagship `server-allowed` is the decision.
 * A targeting match uses the flag value. A completed evaluation that did not match
 * denies (the flag default is false). If Flagship cannot be evaluated, only
 * botiverse is allowed.
 */
export async function isServerAllowed(
	serverId: string | null | undefined,
	flags?: FlagshipBinding,
): Promise<boolean> {
	if (!serverId) return false;
	if (!flags || typeof flags.getBooleanDetails !== "function") {
		return serverId === BOTIVERSE_SERVER_ID;
	}
	try {
		const details = await flags.getBooleanDetails("server-allowed", false, { serverId });
		if (details.reason && FLAG_OVERRIDE.has(details.reason)) return details.value === true;
		if (details.reason === "ERROR" || !details.reason) return serverId === BOTIVERSE_SERVER_ID;
		return false;
	} catch (err) {
		console.warn("[flagship] error evaluating server-allowed flag:", err);
		return serverId === BOTIVERSE_SERVER_ID;
	}
}
