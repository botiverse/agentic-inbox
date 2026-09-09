// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Decide whether an inbound email should wake the mailbox owner's Raft Agent Inbox.
 *
 * Identity stays `raft:${serverId}:${type}:${sub}`. Core's agent-request API
 * currently selects by `serverSlug` + `agentName`, so we cache those from the
 * login-time userinfo as *routing hints*, then bind on the UUID returned by
 * Core. Handle is never the owner key.
 *
 * Payload is metadata only — the body is fetched later via get-email.
 * Putting the body in the wake would make the injection surface built-in.
 *
 * Proactive wake is only for senders on the same Raft server (From maps to a
 * mailbox whose owner.serverId matches) or on the mailbox `inboxNotifyAllow`
 * list. Everyone else still receives the mail; they just don't get a wake.
 */

export type InboxNotifyRouting = {
	serverId: string;
	serverSlug: string;
	agentId: string;
	agentName: string;
};

export type OwnerParts = {
	serverId: string;
	type: "agent" | "human";
	sub: string;
};

export type NotifyDecision =
	| { action: "notify"; routing: InboxNotifyRouting }
	| { action: "skip"; reason: NotifySkipReason };

export type NotifySkipReason =
	| "orphan"
	| "human_owner"
	| "muted"
	| "missing_routing"
	| "routing_mismatch"
	| "not_configured"
	| "sender_not_allowed";

const EVENT_ID_MAX = 200;
/** Hex chars of SHA-256(full raw id) appended when the raw id exceeds 200. */
const EVENT_ID_HASH_HEX = 16;

/**
 * Routing-only fallback when a sealed session predates `server_slug` in userinfo.
 * Identity remains the server UUID; Core's agent-request API still selects by slug.
 * Unknown serverIds stay fail-closed (null routing) until a fresh login stamps slug.
 */
const SERVER_SLUG_BY_ID: Record<string, string> = {
	"95f993fa-2a68-4797-b8ae-7beb7d984ada": "botiverse",
};

/** Parse `raft:${serverId}:${type}:${sub}`. Anything else (incl. local:admin) is not a Raft owner. */
export function parseOwner(owner: string | null | undefined): OwnerParts | null {
	if (!owner) return null;
	const m = owner.match(/^raft:([^:]+):(agent|human):(.+)$/);
	if (!m) return null;
	return { serverId: m[1], type: m[2] as "agent" | "human", sub: m[3] };
}

/**
 * Routing cache from a validated login principal. Requires agent + handle, and a
 * slug from userinfo or the known-id map. Missing any of those → null (fail
 * closed on notify, mailbox still receives).
 */
export function routingFromPrincipal(p: {
	type: string;
	sub: string;
	serverId: string;
	serverSlug?: string | null;
	preferredUsername?: string | null;
}): InboxNotifyRouting | null {
	if (p.type !== "agent") return null;
	const fromUserinfo = (p.serverSlug || "").trim();
	const serverSlug = fromUserinfo || SERVER_SLUG_BY_ID[p.serverId] || "";
	const agentName = (p.preferredUsername || "").trim();
	if (!p.sub || !p.serverId || !serverSlug || !agentName) return null;
	return { serverId: p.serverId, serverSlug, agentId: p.sub, agentName };
}

export type MailboxSettingsRow = Record<string, unknown> & {
	owner?: string;
	fromName?: string;
	inboxNotify?: unknown;
};

/**
 * Stamp login-time routing onto mailbox settings when the caller owns it.
 * No-op if routing is missing or already equal (avoid a write on every request).
 * Never copies routing onto a mailbox owned by someone else.
 */
export function settingsWithNotify(
	settings: MailboxSettingsRow,
	routing: InboxNotifyRouting | null | undefined,
	callerOwner?: string | null,
): { settings: MailboxSettingsRow; wrote: boolean } {
	if (!routing) return { settings, wrote: false };
	if (callerOwner && settings.owner && settings.owner !== callerOwner) {
		return { settings, wrote: false };
	}
	if (JSON.stringify(settings.inboxNotify ?? null) === JSON.stringify(routing)) {
		return { settings, wrote: false };
	}
	return { settings: { ...settings, inboxNotify: routing }, wrote: true };
}

/** Public list/get field: the routing cache, or null if this mailbox will not wake. */
export function publicInboxNotify(settings: MailboxSettingsRow | null | undefined): InboxNotifyRouting | null {
	const r = settings?.inboxNotify as Record<string, unknown> | null | undefined;
	if (!r || typeof r !== "object") return null;
	const serverId = typeof r.serverId === "string" ? r.serverId.trim() : "";
	const serverSlug = typeof r.serverSlug === "string" ? r.serverSlug.trim() : "";
	const agentId = typeof r.agentId === "string" ? r.agentId.trim() : "";
	const agentName = typeof r.agentName === "string" ? r.agentName.trim() : "";
	if (!serverId || !serverSlug || !agentId || !agentName) return null;
	return { serverId, serverSlug, agentId, agentName };
}

/** PUT must not let the caller overwrite owner or inboxNotify. */
export function applySettingsUpdate(
	existing: MailboxSettingsRow,
	incoming: Record<string, unknown>,
): MailboxSettingsRow {
	const { inboxNotify: _n, owner: _o, ...rest } = incoming;
	return { ...existing, ...rest, owner: existing.owner, inboxNotify: existing.inboxNotify };
}

/** Extra wake allowlist: full addresses or domains (`gmail.com` / `@gmail.com`). */
export function parseAllowList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

export function fromOnAllowList(from: string, allow: string[]): boolean {
	const addr = (from || "").trim().toLowerCase();
	if (!addr || allow.length === 0) return false;
	const at = addr.lastIndexOf("@");
	const domain = at >= 0 ? addr.slice(at + 1) : "";
	for (const raw of allow) {
		const e = raw.replace(/^@/, "");
		if (e === addr) return true;
		if (domain && e === domain) return true;
	}
	return false;
}

export function sameServerOwners(
	recipientOwner: string | null | undefined,
	senderOwner: string | null | undefined,
): boolean {
	const a = parseOwner(recipientOwner);
	const b = parseOwner(senderOwner);
	return !!(a && b && a.serverId === b.serverId);
}

export function decideNotify(input: {
	owner: string | null | undefined;
	/** Explicit false is sticky mute. Undefined/true = notify. */
	notifyInbox?: boolean | null;
	routing: InboxNotifyRouting | null | undefined;
	/** Owner of the From mailbox, if it exists on this service. */
	senderOwner?: string | null;
	from?: string | null;
	allowList?: unknown;
}): NotifyDecision {
	const parts = parseOwner(input.owner);
	if (!parts) return { action: "skip", reason: "orphan" };
	if (parts.type === "human") return { action: "skip", reason: "human_owner" };
	if (input.notifyInbox === false) return { action: "skip", reason: "muted" };
	if (!input.routing) return { action: "skip", reason: "missing_routing" };
	if (input.routing.agentId !== parts.sub || input.routing.serverId !== parts.serverId) {
		return { action: "skip", reason: "routing_mismatch" };
	}
	if (sameServerOwners(input.owner, input.senderOwner)) {
		return { action: "notify", routing: input.routing };
	}
	if (fromOnAllowList(input.from || "", parseAllowList(input.allowList))) {
		return { action: "notify", routing: input.routing };
	}
	return { action: "skip", reason: "sender_not_allowed" };
}

async function sha256Hex(s: string, n: number): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
	return hex.slice(0, n);
}

/**
 * Core `externalEventId` — unique per app + target agent, ≤ 200 chars.
 * Over-length: keep a prefix and append SHA-256 of the *full* raw id (not a
 * slice). Truncating would collide two long Message-IDs that share a prefix.
 */
export async function externalEventId(
	mailbox: string,
	rfcMessageId: string | null | undefined,
	fallbackId: string,
): Promise<string> {
	const mbox = (mailbox || "").trim().toLowerCase();
	const rfc = (rfcMessageId || "").trim();
	const raw = rfc ? `mail.build:${mbox}:${rfc}` : `mail.build:${mbox}:id:${fallbackId}`;
	if (raw.length <= EVENT_ID_MAX) return raw;
	const hash = await sha256Hex(raw, EVENT_ID_HASH_HEX);
	const prefixLen = EVENT_ID_MAX - 1 - EVENT_ID_HASH_HEX;
	return `${raw.slice(0, prefixLen)}:${hash}`;
}

export function notifySummary(mailbox: string, from: string, subject: string): string {
	const subj = (subject || "(no subject)").replace(/\s+/g, " ").trim();
	const text = `New mail at ${mailbox} from ${from || "unknown"}: ${subj}`;
	return text.length <= 500 ? text : `${text.slice(0, 497)}...`;
}

/** Metadata only. Never the body. */
export function notifyPayload(input: {
	mailbox: string;
	emailId: string;
	from: string;
	subject: string;
	rfcMessageId: string | null;
}): Record<string, string | null> {
	return {
		provider: "mail.build",
		kind: "inbound_email",
		mailbox: input.mailbox,
		emailId: input.emailId,
		from: input.from,
		subject: input.subject,
		rfcMessageId: input.rfcMessageId,
	};
}
