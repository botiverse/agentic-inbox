// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import {
	parseOwner,
	routingFromPrincipal,
	notifyEnabled,
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
	});
});

describe("notifyEnabled", () => {
	it("is off unless an explicit truthy flag", () => {
		expect(notifyEnabled(undefined)).toBe(false);
		expect(notifyEnabled("")).toBe(false);
		expect(notifyEnabled("0")).toBe(false);
		expect(notifyEnabled("1")).toBe(true);
		expect(notifyEnabled("true")).toBe(true);
	});
});

describe("decideNotify", () => {
	const owner = "raft:s1:agent:agent-uuid";
	it("notifies an agent owner when enabled and routing matches", () => {
		expect(decideNotify({ enabled: true, owner, routing })).toEqual({ action: "notify", routing });
	});
	it("skips when the delivery flag is off", () => {
		expect(decideNotify({ enabled: false, owner, routing })).toEqual({ action: "skip", reason: "disabled" });
	});
	it("skips ownerless mailboxes instead of pretending someone is there", () => {
		expect(decideNotify({ enabled: true, owner: null, routing })).toEqual({ action: "skip", reason: "orphan" });
	});
	it("skips human-owned mailboxes (agent-events requires an agent token)", () => {
		expect(decideNotify({ enabled: true, owner: "raft:s1:human:h1", routing })).toEqual({
			action: "skip", reason: "human_owner",
		});
	});
	it("honours sticky mute without releasing the mailbox", () => {
		expect(decideNotify({ enabled: true, owner, routing, notifyInbox: false })).toEqual({
			action: "skip", reason: "muted",
		});
	});
	it("skips when login never cached slug+handle", () => {
		expect(decideNotify({ enabled: true, owner, routing: null })).toEqual({
			action: "skip", reason: "missing_routing",
		});
	});
	it("skips when cached routing does not match the owner UUID", () => {
		expect(decideNotify({
			enabled: true, owner, routing: { ...routing, agentId: "someone-else" },
		})).toEqual({ action: "skip", reason: "routing_mismatch" });
		expect(decideNotify({
			enabled: true, owner, routing: { ...routing, serverId: "other-server" },
		})).toEqual({ action: "skip", reason: "routing_mismatch" });
	});
});

describe("externalEventId", () => {
	it("keys on mailbox + RFC Message-ID", () => {
		expect(externalEventId("Postel@mail.build", "<abc@x>", "uuid")).toBe("mail.build:postel@mail.build:<abc@x>");
	});
	it("falls back to the internal id when Message-ID is missing", () => {
		expect(externalEventId("a@mail.build", null, "id-1")).toBe("mail.build:a@mail.build:id:id-1");
	});
	it("caps at 200 characters", () => {
		const long = "x".repeat(300);
		expect(externalEventId("a@mail.build", long, "id").length).toBe(200);
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
