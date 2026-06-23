// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Dynamic mailbox allow logic.
 *
 * An address (recipient or to-be-created mailbox) is permitted if it is either:
 *   1. explicitly listed in EMAIL_ADDRESSES (literal allowlist — backwards-compatible), OR
 *   2. under one of the configured DOMAINS (dynamic self-service — any
 *      `<local-part>@<domain>` can be created/received without a redeploy).
 *
 * Receive- and create-time gates share this so behaviour stays consistent.
 * Note: mailbox *existence* in R2 remains the real delivery gate in
 * `receiveEmail` — this only decides whether an address is eligible at all.
 */

/** Parse a comma-separated DOMAINS env string into a normalised list. */
export function parseDomains(domainsRaw: string | undefined): string[] {
	return (domainsRaw || "")
		.split(",")
		.map((d) => d.trim().toLowerCase())
		.filter(Boolean);
}

/** Extract the lowercased domain part of an email address (""+ if malformed). */
export function domainOf(email: string): string {
	return email.toLowerCase().split("@")[1] ?? "";
}

/**
 * Whether an address is allowed by either the explicit allowlist or a
 * configured domain. Case-insensitive.
 */
export function isAddressAllowed(
	address: string,
	allowedAddresses: string[],
	allowedDomains: string[],
): boolean {
	const addr = address.toLowerCase();
	if (allowedAddresses.map((a) => a.toLowerCase()).includes(addr)) return true;
	return allowedDomains.map((d) => d.toLowerCase()).includes(domainOf(addr));
}
