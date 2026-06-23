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
