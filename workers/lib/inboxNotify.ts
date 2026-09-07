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
	| "not_configured";

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

export function decideNotify(input: {
	owner: string | null | undefined;
	/** Explicit false is sticky mute. Undefined/true = notify. */
	notifyInbox?: boolean | null;
	routing: InboxNotifyRouting | null | undefined;
}): NotifyDecision {
	const parts = parseOwner(input.owner);
	if (!parts) return { action: "skip", reason: "orphan" };
	if (parts.type === "human") return { action: "skip", reason: "human_owner" };
	if (input.notifyInbox === false) return { action: "skip", reason: "muted" };
	if (!input.routing) return { action: "skip", reason: "missing_routing" };
	if (input.routing.agentId !== parts.sub || input.routing.serverId !== parts.serverId) {
		return { action: "skip", reason: "routing_mismatch" };
	}
	return { action: "notify", routing: input.routing };
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
