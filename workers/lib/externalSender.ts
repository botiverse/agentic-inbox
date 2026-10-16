// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Stamp `external_sender` on read models. Same comparison as the agent wake
 * (`sameServerOwners`): the From mailbox's owner must share a Raft server id
 * with this mailbox's owner. `inboxNotifyAllow` is not consulted.
 */
import { isExternalSender } from "./inboxNotify";
import { mailboxOf, readMailboxSettings } from "./mailboxRef";
import type { Env } from "../types";

type SenderRow = { from?: string | null; sender?: string | null };

/** Bare address from a stored From. Tolerates `Name <a@b>`. Empty when there is no address. */
export function senderAddress(from: string | null | undefined): string {
	const raw = (from || "").trim();
	if (!raw) return "";
	const angled = raw.match(/<([^<>]+)>/);
	const bare = (angled ? angled[1] : raw).trim().toLowerCase();
	if (!bare.includes("@") || /\s/.test(bare)) return "";
	return bare;
}

async function ownerOf(env: Pick<Env, "BUCKET">, address: string): Promise<string | null> {
	try {
		const settings = await readMailboxSettings<{ owner?: string }>(env, address);
		const owner = settings?.owner;
		return typeof owner === "string" && owner ? owner : null;
	} catch {
		return null;
	}
}

/**
 * One settings read for the mailbox, plus one per distinct sender mailbox.
 * An empty list does no reads. A thrown settings read fails closed (external).
 */
export async function stampExternalSenders<T extends SenderRow>(
	env: Pick<Env, "BUCKET">,
	mailbox: string,
	rows: T[],
): Promise<Array<T & { external_sender: boolean }>> {
	if (rows.length === 0) return [];
	const mailboxOwner = await ownerOf(env, mailbox);
	const keys = rows.map((row) => {
		const addr = senderAddress(row.from || row.sender);
		return addr ? mailboxOf(addr) : "";
	});
	const unique = [...new Set(keys.filter(Boolean))];
	const owners = new Map<string, string | null>();
	await Promise.all(unique.map(async (key) => {
		owners.set(key, await ownerOf(env, key));
	}));
	return rows.map((row, i) => {
		const key = keys[i];
		const senderOwner = key ? owners.get(key) ?? null : null;
		return { ...row, external_sender: isExternalSender(mailboxOwner, senderOwner) };
	});
}
