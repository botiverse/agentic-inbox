// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * App → Agent inbound notification client (Core `POST /api/oauth/agent-events`).
 *
 * Contract: raft-docs "Sending events to an agent" + chess production path.
 * Token can only target its bound agent. Unknown transport results are the
 * caller's problem — do not blindly retry without the same externalEventId.
 */

import {
	decideNotify,
	externalEventId,
	notifyPayload,
	notifySummary,
	type InboxNotifyRouting,
} from "./inboxNotify";
import { readMailboxSettings } from "./mailboxRef";

export type AgentEventsConfig = {
	apiOrigin: string;
	clientKey: string;
	clientSecret: string;
};

export type AgentEventPostResult = {
	httpStatus: number;
	status: "queued" | "duplicate" | "error";
	deduped: boolean;
	id: string | null;
	closedError: string | null;
};

function basicAuth(config: AgentEventsConfig): string {
	const bytes = new TextEncoder().encode(`${config.clientKey}:${config.clientSecret}`);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return `Basic ${btoa(binary)}`;
}

export function agentInboundResource(serverId: string): string {
	return `urn:raft:server:${serverId}:agent-inbound`;
}

type AgentRequestResponse = {
	requestId?: string;
	status?: string;
	agent?: { id?: string; serverId?: string; name?: string; serverSlug?: string };
};

export class AgentEventsError extends Error {
	constructor(
		public readonly closedError: string,
		message: string,
	) {
		super(message);
		this.name = "AgentEventsError";
	}
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
	const text = await res.text().catch(() => "");
	if (!text) return null;
	try {
		const v = JSON.parse(text) as unknown;
		return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Mint a resource-bound inbound token for one agent. Verifies the Core-selected
 * agent UUID/server match our owner (slug+name are only the selector).
 */
export async function mintInboundToken(
	config: AgentEventsConfig,
	routing: InboxNotifyRouting,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const requestRes = await fetchImpl(`${config.apiOrigin}/api/oauth/requests/agent`, {
		method: "POST",
		headers: {
			Authorization: basicAuth(config),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			serverSlug: routing.serverSlug,
			agentName: routing.agentName,
			scopes: ["agent:notification:write"],
		}),
	});
	const requestBody = (await readJson(requestRes)) as AgentRequestResponse | null;
	if (!requestRes.ok || !requestBody?.requestId || !requestBody.agent?.id || !requestBody.agent.serverId) {
		throw new AgentEventsError("token_request_failed", "agent access request failed");
	}
	if (requestBody.agent.id !== routing.agentId || requestBody.agent.serverId !== routing.serverId) {
		throw new AgentEventsError("token_mismatch", "Core selected a different agent than the mailbox owner");
	}

	const tokenRes = await fetchImpl(`${config.apiOrigin}/api/oauth/token`, {
		method: "POST",
		headers: {
			Authorization: basicAuth(config),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			grant_type: "urn:slock:grant-type:agent_request",
			request_id: requestBody.requestId,
			resource: agentInboundResource(requestBody.agent.serverId),
		}),
	});
	const tokenBody = await readJson(tokenRes);
	const access = tokenBody && typeof tokenBody.access_token === "string" ? tokenBody.access_token : "";
	if (!tokenRes.ok || !access) {
		throw new AgentEventsError("token_request_failed", "inbound token exchange failed");
	}
	return access;
}

export async function postAgentNotification(
	config: AgentEventsConfig,
	accessToken: string,
	input: {
		summary: string;
		payload: Record<string, unknown>;
		externalEventId: string;
	},
	fetchImpl: typeof fetch = fetch,
): Promise<AgentEventPostResult> {
	const res = await fetchImpl(`${config.apiOrigin}/api/oauth/agent-events`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			kind: "notification",
			summary: input.summary,
			payload: input.payload,
			externalEventId: input.externalEventId,
		}),
	});
	const body = await readJson(res);
	if (res.status === 202) {
		return {
			httpStatus: 202,
			status: "queued",
			deduped: false,
			id: typeof body?.id === "string" ? body.id : null,
			closedError: null,
		};
	}
	if (res.status === 200) {
		const deduped = body?.deduped === true || body?.status === "duplicate";
		const status = body?.status === "queued" ? "queued" : "duplicate";
		return {
			httpStatus: 200,
			status,
			deduped,
			id: typeof body?.id === "string" ? body.id : null,
			closedError: null,
		};
	}
	return {
		httpStatus: res.status,
		status: "error",
		deduped: false,
		id: null,
		closedError: "post_failed",
	};
}

type NotifyEnv = {
	RAFT_API_ORIGIN?: string;
	RAFT_OAUTH_CLIENT_KEY?: string;
	RAFT_OAUTH_CLIENT_SECRET?: string;
	BUCKET: { get: (key: string) => Promise<{ json: () => Promise<unknown> } | null> };
};

/**
 * Best-effort wake of the mailbox owner. Never throws to the SMTP path.
 * Duplicate provider events reuse externalEventId so Core de-dupes.
 */
export async function runInboundNotify(
	env: NotifyEnv,
	input: {
		mailbox: string;
		emailId: string;
		from: string;
		subject: string;
		rfcMessageId: string | null;
	},
	fetchImpl: typeof fetch = fetch,
): Promise<{ skipped?: string; post?: AgentEventPostResult; closedError?: string }> {
	if (!env.RAFT_API_ORIGIN || !env.RAFT_OAUTH_CLIENT_KEY || !env.RAFT_OAUTH_CLIENT_SECRET) {
		return { skipped: "not_configured" };
	}
	const settings = await readMailboxSettings<{
		owner?: string;
		notifyInbox?: boolean;
		inboxNotify?: InboxNotifyRouting;
	}>(env as never, input.mailbox);
	const decision = decideNotify({
		owner: settings?.owner,
		notifyInbox: settings?.notifyInbox,
		routing: settings?.inboxNotify,
	});
	if (decision.action === "skip") return { skipped: decision.reason };

	try {
		const token = await mintInboundToken(
			{
				apiOrigin: env.RAFT_API_ORIGIN,
				clientKey: env.RAFT_OAUTH_CLIENT_KEY,
				clientSecret: env.RAFT_OAUTH_CLIENT_SECRET,
			},
			decision.routing,
			fetchImpl,
		);
		const post = await postAgentNotification(
			{
				apiOrigin: env.RAFT_API_ORIGIN,
				clientKey: env.RAFT_OAUTH_CLIENT_KEY,
				clientSecret: env.RAFT_OAUTH_CLIENT_SECRET,
			},
			token,
			{
				summary: notifySummary(input.mailbox, input.from, input.subject),
				payload: notifyPayload({
					mailbox: input.mailbox,
					emailId: input.emailId,
					from: input.from,
					subject: input.subject,
					rfcMessageId: input.rfcMessageId,
				}),
				externalEventId: await externalEventId(input.mailbox, input.rfcMessageId, input.emailId),
			},
			fetchImpl,
		);
		return { post, closedError: post.closedError ?? undefined };
	} catch (e) {
		const closed = e instanceof AgentEventsError ? e.closedError : "post_failed";
		return { closedError: closed };
	}
}
