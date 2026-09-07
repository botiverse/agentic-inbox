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
	| "disabled"
	| "orphan"
	| "human_owner"
	| "muted"
	| "missing_routing"
	| "routing_mismatch";

const EVENT_ID_MAX = 200;

/** Parse `raft:${serverId}:${type}:${sub}`. Anything else (incl. local:admin) is not a Raft owner. */
export function parseOwner(owner: string | null | undefined): OwnerParts | null {
	if (!owner) return null;
	const m = owner.match(/^raft:([^:]+):(agent|human):(.+)$/);
	if (!m) return null;
	return { serverId: m[1], type: m[2] as "agent" | "human", sub: m[3] };
}

/**
 * Routing cache from a validated login principal. Requires agent + slug + handle.
 * Missing any of those → null (fail closed on notify, mailbox still receives).
 */
export function routingFromPrincipal(p: {
	type: string;
	sub: string;
	serverId: string;
	serverSlug?: string | null;
	preferredUsername?: string | null;
}): InboxNotifyRouting | null {
	if (p.type !== "agent") return null;
	const serverSlug = (p.serverSlug || "").trim();
	const agentName = (p.preferredUsername || "").trim();
	if (!p.sub || !p.serverId || !serverSlug || !agentName) return null;
	return { serverId: p.serverId, serverSlug, agentId: p.sub, agentName };
}

export function notifyEnabled(flag: string | undefined | null): boolean {
	const v = (flag || "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

export function decideNotify(input: {
	enabled: boolean;
	owner: string | null | undefined;
	/** Explicit false is sticky mute. Undefined/true = notify. */
	notifyInbox?: boolean | null;
	routing: InboxNotifyRouting | null | undefined;
}): NotifyDecision {
	if (!input.enabled) return { action: "skip", reason: "disabled" };
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

/** Core `externalEventId` — unique per app + target agent, ≤ 200 chars. */
export function externalEventId(mailbox: string, rfcMessageId: string | null | undefined, fallbackId: string): string {
	const mbox = (mailbox || "").trim().toLowerCase();
	const rfc = (rfcMessageId || "").trim();
	const raw = rfc ? `mail.build:${mbox}:${rfc}` : `mail.build:${mbox}:id:${fallbackId}`;
	if (raw.length <= EVENT_ID_MAX) return raw;
	return raw.slice(0, EVENT_ID_MAX);
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
