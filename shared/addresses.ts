// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Address helpers shared by the Worker and the web UI. Kept in `shared/` on
 * purpose: the delivery path and the compose path MUST agree on what "the same
 * mailbox" means, and two copies of this rule would drift (inbound would treat
 * `a+tag@x` as `a@x` while the UI treated them as different people).
 */

/**
 * Resolve the mailbox an address delivers to, stripping any `+tag` sub-address
 * (`artin+staging-smoke@mail.build` → `artin@mail.build`). Plus-addressing lets
 * one mailbox receive on unlimited ad-hoc addresses; the tag is for the
 * recipient's own filtering, not a separate mailbox (AX: artin).
 *
 * Left unchanged when there is no `+`, when `+` is the first character (which
 * would leave an empty local-part), or when there is no local-part/`@` — those
 * fall through to the normal "no such mailbox" path rather than silently
 * resolving somewhere unintended.
 */
export function deliveryMailbox(address: string): string {
	const at = address.lastIndexOf("@");
	if (at < 1) return address;
	const local = address.slice(0, at);
	const plus = local.indexOf("+");
	if (plus < 1) return address;
	return `${local.slice(0, plus)}@${address.slice(at + 1)}`;
}

/** Whether two addresses reach the same mailbox, ignoring case and any `+tag`. */
export function sameMailbox(a: string, b: string): boolean {
	if (!a || !b) return false;
	return deliveryMailbox(a.trim().toLowerCase()) === deliveryMailbox(b.trim().toLowerCase());
}

/**
 * Which of a message's recipient addresses is *this* mailbox — preserving any
 * `+tag`. Used to reply AS the alias the sender wrote to, instead of exposing the
 * base address (artin's call; the Proton behaviour: "reply from the alias, keep
 * the real address hidden"). Falls back to the bare mailbox when the message
 * carries no address belonging to it (e.g. delivered via Bcc).
 *
 * `recipients` is the stored comma-separated list; pass To and Cc together.
 */
export function receivedAtAddress(recipients: string | null | undefined, mailbox: string): string {
	if (!recipients) return mailbox;
	for (const raw of recipients.split(",")) {
		const addr = raw.trim();
		// tolerate `Name <a@b>` display form
		const angled = addr.match(/<([^>]+)>/);
		const bare = (angled ? angled[1] : addr).trim().toLowerCase();
		if (bare && sameMailbox(bare, mailbox)) return bare;
	}
	return mailbox;
}
