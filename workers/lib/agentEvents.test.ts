// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import {
	agentInboundResource,
	mintInboundToken,
	postAgentNotification,
	runInboundNotify,
	AgentEventsError,
	type AgentEventsConfig,
} from "./agentEvents";
import type { InboxNotifyRouting } from "./inboxNotify";

const config: AgentEventsConfig = {
	apiOrigin: "https://api.raft.build",
	clientKey: "agentic-inbox",
	clientSecret: "s3cret",
};

const routing: InboxNotifyRouting = {
	serverId: "s1",
	serverSlug: "botiverse",
	agentId: "agent-uuid",
	agentName: "postel",
};

function seqFetch(replies: Array<{ urlIncludes: string; status: number; body: unknown; capture?: { req?: Request; body?: string } }>): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input as Request | string, init);
		const url = req.url;
		const match = replies.find((r) => url.includes(r.urlIncludes));
		if (!match) return new Response("no mock", { status: 500 });
		if (match.capture) {
			match.capture.req = req;
			match.capture.body = init?.body ? String(init.body) : await req.clone().text().catch(() => "");
		}
		return new Response(JSON.stringify(match.body), {
			status: match.status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

describe("agentInboundResource", () => {
	it("is the RFC8707 urn from the server UUID", () => {
		expect(agentInboundResource("s1")).toBe("urn:raft:server:s1:agent-inbound");
	});
});

describe("mintInboundToken", () => {
	it("requests by slug+name then exchanges with the returned serverId resource", async () => {
		const requestCap: { body?: string } = {};
		const tokenCap: { body?: string } = {};
		const fetchImpl = seqFetch([
			{
				urlIncludes: "/api/oauth/requests/agent",
				status: 200,
				body: {
					requestId: "req-1",
					status: "approved",
					agent: { id: "agent-uuid", serverId: "s1", name: "postel", serverSlug: "botiverse" },
				},
				capture: requestCap,
			},
			{
				urlIncludes: "/api/oauth/token",
				status: 200,
				body: { access_token: "tok", token_type: "Bearer" },
				capture: tokenCap,
			},
		]);
		await expect(mintInboundToken(config, routing, fetchImpl)).resolves.toBe("tok");
		expect(JSON.parse(requestCap.body || "{}")).toEqual({
			serverSlug: "botiverse",
			agentName: "postel",
			scopes: ["agent:notification:write"],
		});
		expect(JSON.parse(tokenCap.body || "{}")).toEqual({
			grant_type: "urn:slock:grant-type:agent_request",
			request_id: "req-1",
			resource: "urn:raft:server:s1:agent-inbound",
		});
	});

	it("refuses when Core returns a different agent than the mailbox owner", async () => {
		const fetchImpl = seqFetch([
			{
				urlIncludes: "/api/oauth/requests/agent",
				status: 200,
				body: {
					requestId: "req-1",
					agent: { id: "other-agent", serverId: "s1" },
				},
			},
		]);
		await expect(mintInboundToken(config, routing, fetchImpl)).rejects.toMatchObject({
			closedError: "token_mismatch",
		});
	});

	it("refuses when Core returns a different server", async () => {
		const fetchImpl = seqFetch([
			{
				urlIncludes: "/api/oauth/requests/agent",
				status: 200,
				body: {
					requestId: "req-1",
					agent: { id: "agent-uuid", serverId: "other-server" },
				},
			},
		]);
		await expect(mintInboundToken(config, routing, fetchImpl)).rejects.toBeInstanceOf(AgentEventsError);
	});
});

describe("postAgentNotification", () => {
	it("treats 202 as a new queued event", async () => {
		const cap: { body?: string } = {};
		const fetchImpl = seqFetch([
			{
				urlIncludes: "/api/oauth/agent-events",
				status: 202,
				body: { status: "queued", deduped: false, id: "evt-1" },
				capture: cap,
			},
		]);
		const r = await postAgentNotification(config, "tok", {
			summary: "New mail",
			payload: { mailbox: "a@mail.build", emailId: "e1" },
			externalEventId: "mail.build:a@mail.build:<m>",
		}, fetchImpl);
		expect(r).toEqual({ httpStatus: 202, status: "queued", deduped: false, id: "evt-1", closedError: null });
		const sent = JSON.parse(cap.body || "{}");
		expect(sent.kind).toBe("notification");
		expect(sent.payload).not.toHaveProperty("body");
	});

	it("treats 200 duplicate as idempotent, not a new delivery", async () => {
		const fetchImpl = seqFetch([
			{
				urlIncludes: "/api/oauth/agent-events",
				status: 200,
				body: { status: "duplicate", deduped: true, id: "evt-1" },
			},
		]);
		const r = await postAgentNotification(config, "tok", {
			summary: "New mail",
			payload: {},
			externalEventId: "same",
		}, fetchImpl);
		expect(r.status).toBe("duplicate");
		expect(r.deduped).toBe(true);
		expect(r.closedError).toBeNull();
	});

	it("maps non-2xx to a closed-set error without throwing", async () => {
		const fetchImpl = seqFetch([
			{ urlIncludes: "/api/oauth/agent-events", status: 403, body: { error: "insufficient_scope" } },
		]);
		const r = await postAgentNotification(config, "tok", {
			summary: "New mail", payload: {}, externalEventId: "x",
		}, fetchImpl);
		expect(r.status).toBe("error");
		expect(r.closedError).toBe("post_failed");
		expect(r.httpStatus).toBe(403);
	});
});

describe("runInboundNotify", () => {
	const mailbox = "postel@mail.build";
	const routing = {
		serverId: "s1",
		serverSlug: "botiverse",
		agentId: "agent-uuid",
		agentName: "postel",
	};
	function env(byMailbox: Record<string, unknown>) {
		return {
			RAFT_API_ORIGIN: "https://api.raft.build",
			RAFT_OAUTH_CLIENT_KEY: "agentic-inbox",
			RAFT_OAUTH_CLIENT_SECRET: "s3cret",
			BUCKET: {
				get: async (key: string) => {
					const id = key.replace("mailboxes/", "").replace(".json", "");
					const settings = byMailbox[id];
					return settings == null ? null : { json: async () => settings };
				},
			},
		};
	}
	const mail = {
		mailbox,
		emailId: "e1",
		from: "artin@mail.build",
		subject: "code",
		rfcMessageId: "<m@x>",
	};
	const recipient = {
		owner: "raft:s1:agent:agent-uuid",
		inboxNotify: routing,
	};

	it("skips ownerless mailboxes", async () => {
		const r = await runInboundNotify(env({ [mailbox]: {} }), mail);
		expect(r.skipped).toBe("orphan");
	});

	it("skips an off-server sender instead of waking", async () => {
		const r = await runInboundNotify(env({ [mailbox]: recipient }), {
			...mail, from: "eve@evil.test",
		});
		expect(r.skipped).toBe("sender_not_allowed");
	});

	it("posts a metadata-only notification when routing matches", async () => {
		const cap: { body?: string } = {};
		const fetchImpl = seqFetch([
			{
				urlIncludes: "/api/oauth/requests/agent",
				status: 200,
				body: { requestId: "req-1", agent: { id: "agent-uuid", serverId: "s1" } },
			},
			{
				urlIncludes: "/api/oauth/token",
				status: 200,
				body: { access_token: "tok" },
			},
			{
				urlIncludes: "/api/oauth/agent-events",
				status: 202,
				body: { status: "queued", deduped: false, id: "evt-1" },
				capture: cap,
			},
		]);
		const r = await runInboundNotify(env({
			[mailbox]: recipient,
			"artin@mail.build": { owner: "raft:s1:human:artin" },
		}), mail, fetchImpl);
		expect(r.post?.status).toBe("queued");
		expect(r.post?.deduped).toBe(false);
		const sent = JSON.parse(cap.body || "{}");
		expect(sent.kind).toBe("notification");
		expect(sent.externalEventId).toBe("mail.build:postel@mail.build:<m@x>");
		expect(sent.payload.body).toBeUndefined();
		expect(sent.payload.emailId).toBe("e1");
	});
});
