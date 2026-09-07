// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import {
	parseOwner,
	routingFromPrincipal,
	decideNotify,
	externalEventId,
	notifySummary,
	notifyPayload,
	type InboxNotifyRouting,
} from "./inboxNotify";

const routing: InboxNotifyRouting = {
	serverId: "s1",
	serverSlug: "botiverse",
	agentId: "agent-uuid",
	agentName: "postel",
};

describe("parseOwner", () => {
	it("splits raft:server:type:sub", () => {
		expect(parseOwner("raft:s1:agent:abc")).toEqual({ serverId: "s1", type: "agent", sub: "abc" });
		expect(parseOwner("raft:s1:human:h1")).toEqual({ serverId: "s1", type: "human", sub: "h1" });
	});
	it("rejects non-raft owners", () => {
		expect(parseOwner("local:admin")).toBeNull();
		expect(parseOwner(null)).toBeNull();
		expect(parseOwner("raft:s1:bot:x")).toBeNull();
	});
});

describe("routingFromPrincipal", () => {
	const botiverseId = "95f993fa-2a68-4797-b8ae-7beb7d984ada";

	it("requires agent + slug + handle; handle is a routing hint not the owner key", () => {
		expect(routingFromPrincipal({
			type: "agent", sub: "abc", serverId: "s1", serverSlug: "botiverse", preferredUsername: "Postel",
		})).toEqual({ serverId: "s1", serverSlug: "botiverse", agentId: "abc", agentName: "Postel" });
		expect(routingFromPrincipal({
			type: "human", sub: "h1", serverId: "s1", serverSlug: "botiverse", preferredUsername: "artin",
		})).toBeNull();
		expect(routingFromPrincipal({
			type: "agent", sub: "abc", serverId: "s1", serverSlug: null, preferredUsername: "Postel",
		})).toBeNull();
		// Other allow-listed servers are not in the slug map: old sessions stay fail-closed.
		expect(routingFromPrincipal({
			type: "agent",
			sub: "abc",
			serverId: "172dbfbf-3e86-4a85-9331-d4c3f5c1c558",
			serverSlug: null,
			preferredUsername: "Postel",
		})).toBeNull();
	});

	it("fills slug from the known serverId map when a pre-deploy session omitted it", () => {
		const expected = {
			serverId: botiverseId, serverSlug: "botiverse", agentId: "abc", agentName: "Gogo",
		};
		expect(routingFromPrincipal({
			type: "agent", sub: "abc", serverId: botiverseId, serverSlug: null, preferredUsername: "Gogo",
		})).toEqual(expected);
		expect(routingFromPrincipal({
			type: "agent", sub: "abc", serverId: botiverseId, serverSlug: "", preferredUsername: "Gogo",
		})).toEqual(expected);
		expect(routingFromPrincipal({
			type: "agent", sub: "abc", serverId: botiverseId, preferredUsername: "Gogo",
		})).toEqual(expected);
	});

	it("prefers the userinfo slug over the known-id map", () => {
		expect(routingFromPrincipal({
			type: "agent",
			sub: "abc",
			serverId: botiverseId,
			serverSlug: "renamed",
			preferredUsername: "Gogo",
		})).toEqual({
			serverId: botiverseId, serverSlug: "renamed", agentId: "abc", agentName: "Gogo",
		});
	});

	it("still fails closed without a handle, even on a known serverId", () => {
		expect(routingFromPrincipal({
			type: "agent", sub: "abc", serverId: botiverseId, serverSlug: null, preferredUsername: null,
		})).toBeNull();
		expect(routingFromPrincipal({
			type: "human", sub: "h1", serverId: botiverseId, serverSlug: null, preferredUsername: "artin",
		})).toBeNull();
	});
});

describe("decideNotify", () => {
	const owner = "raft:s1:agent:agent-uuid";
	it("notifies an agent owner when routing matches", () => {
		expect(decideNotify({ owner, routing })).toEqual({ action: "notify", routing });
	});
	it("skips ownerless mailboxes instead of pretending someone is there", () => {
		expect(decideNotify({ owner: null, routing })).toEqual({ action: "skip", reason: "orphan" });
	});
	it("skips human-owned mailboxes (agent-events requires an agent token)", () => {
		expect(decideNotify({ owner: "raft:s1:human:h1", routing })).toEqual({
			action: "skip", reason: "human_owner",
		});
	});
	it("honours sticky mute without releasing the mailbox", () => {
		expect(decideNotify({ owner, routing, notifyInbox: false })).toEqual({
			action: "skip", reason: "muted",
		});
	});
	it("skips when login never cached slug+handle", () => {
		expect(decideNotify({ owner, routing: null })).toEqual({
			action: "skip", reason: "missing_routing",
		});
	});
	it("skips when cached routing does not match the owner UUID", () => {
		expect(decideNotify({
			owner, routing: { ...routing, agentId: "someone-else" },
		})).toEqual({ action: "skip", reason: "routing_mismatch" });
		expect(decideNotify({
			owner, routing: { ...routing, serverId: "other-server" },
		})).toEqual({ action: "skip", reason: "routing_mismatch" });
	});
});

describe("externalEventId", () => {
	it("keys on mailbox + RFC Message-ID", async () => {
		expect(await externalEventId("Postel@mail.build", "<abc@x>", "uuid")).toBe("mail.build:postel@mail.build:<abc@x>");
	});
	it("falls back to the internal id when Message-ID is missing", async () => {
		expect(await externalEventId("a@mail.build", null, "id-1")).toBe("mail.build:a@mail.build:id:id-1");
	});
	it("keeps over-long ids unique instead of truncating", async () => {
		const a = "x".repeat(250) + "A";
		const b = "x".repeat(250) + "B";
		const idA = await externalEventId("a@mail.build", a, "id");
		const idB = await externalEventId("a@mail.build", b, "id");
		expect(idA.length).toBe(200);
		expect(idB.length).toBe(200);
		expect(idA).not.toBe(idB);
		expect(idA.slice(-17)).toMatch(/^:[0-9a-f]{16}$/);
	});
});

describe("notify payload is metadata-only", () => {
	it("does not include a body field", () => {
		const p = notifyPayload({
			mailbox: "postel@mail.build",
			emailId: "e1",
			from: "noreply@example.com",
			subject: "code",
			rfcMessageId: "<m@x>",
		});
		expect(p).toEqual({
			provider: "mail.build",
			kind: "inbound_email",
			mailbox: "postel@mail.build",
			emailId: "e1",
			from: "noreply@example.com",
			subject: "code",
			rfcMessageId: "<m@x>",
		});
		expect("body" in p).toBe(false);
	});
	it("keeps the summary within 500 chars", () => {
		expect(notifySummary("a@mail.build", "b@x", "hi").length).toBeLessThanOrEqual(500);
		expect(notifySummary("a@mail.build", "b@x", "z".repeat(600)).length).toBe(500);
	});
});
