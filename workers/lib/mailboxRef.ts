// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The single place that maps an EMAIL ADDRESS to the MAILBOX that owns it.
 *
 * Every lookup — R2 settings object, MailboxDO instance, EmailAgent instance —
 * must agree on this mapping, including `+tag` sub-addressing. Spreading the
 * rule across call sites is how it gets forgotten: the inbound path was fixed
 * for `+` while internal send still looked up the raw address, so agent-to-agent
 * mail to `someone+tag@` 404'd even though external mail to it delivered.
 *
 * Route every address→storage/DO lookup through here so normalization is
 * structural rather than remembered.
 */
import { deliveryMailbox } from "../../shared/addresses";
import type { Env } from "../types";

/** The mailbox an address belongs to: lower-cased, `+tag` removed. */
export function mailboxOf(address: string): string {
	return deliveryMailbox((address || "").trim().toLowerCase());
}

/** R2 key holding a mailbox's settings. */
export function mailboxKey(address: string): string {
	return `mailboxes/${mailboxOf(address)}.json`;
}

/** Whether the mailbox behind this address exists (HEAD — no body read). */
export async function mailboxExists(env: Pick<Env, "BUCKET">, address: string): Promise<boolean> {
	return Boolean(await env.BUCKET.head(mailboxKey(address)));
}

/** A mailbox's stored settings, or null when it doesn't exist / isn't parseable. */
export async function readMailboxSettings<T = Record<string, unknown>>(
	env: Pick<Env, "BUCKET">,
	address: string,
): Promise<T | null> {
	const obj = await env.BUCKET.get(mailboxKey(address));
	if (!obj) return null;
	return (await obj.json().catch(() => null)) as T | null;
}

/** The MailboxDO instance for this address. */
export function mailboxStub(env: Pick<Env, "MAILBOX">, address: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxOf(address)));
}

/** The EmailAgent instance for this address. */
export function emailAgentStub(env: Pick<Env, "EMAIL_AGENT">, address: string) {
	return env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxOf(address)));
}
