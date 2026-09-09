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
	settingsWithNotify,
	publicInboxNotify,
	applySettingsUpdate,
	fromOnAllowList,
	parseAllowList,
	sameServerOwners,
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

describe("settingsWithNotify", () => {
	const owner = "raft:s1:agent:abc";
	it("stamps routing onto a mailbox that has none", () => {
		const { settings, wrote } = settingsWithNotify({ owner, fromName: "Gogo" }, routing, owner);
		expect(wrote).toBe(true);
		expect(settings.inboxNotify).toEqual(routing);
		expect(settings.fromName).toBe("Gogo");
	});
	it("does not write when routing is already equal", () => {
		const { wrote } = settingsWithNotify({ owner, inboxNotify: routing }, routing, owner);
		expect(wrote).toBe(false);
	});
	it("does not stamp without routing (fail closed, same as missing_routing)", () => {
		expect(settingsWithNotify({ owner }, null, owner)).toEqual({
			settings: { owner }, wrote: false,
		});
	});
	it("does not copy routing onto someone else's mailbox", () => {
		const { wrote, settings } = settingsWithNotify(
			{ owner: "raft:s1:agent:other" }, routing, owner,
		);
		expect(wrote).toBe(false);
		expect(settings.inboxNotify).toBeUndefined();
	});
});

describe("publicInboxNotify", () => {
	it("returns the routing or null — never a partial object", () => {
		expect(publicInboxNotify({ inboxNotify: routing })).toEqual(routing);
		expect(publicInboxNotify({ inboxNotify: { serverId: "s1" } as InboxNotifyRouting })).toBeNull();
		expect(publicInboxNotify({})).toBeNull();
		expect(publicInboxNotify(null)).toBeNull();
	});
});

describe("applySettingsUpdate", () => {
	it("lets the caller change fromName but not owner or inboxNotify", () => {
		const existing = { owner: "raft:s1:agent:abc", fromName: "Old", inboxNotify: routing };
		const next = applySettingsUpdate(existing, {
			fromName: "New", owner: "raft:s1:agent:evil", inboxNotify: { ...routing, agentName: "Evil" },
		});
		expect(next.fromName).toBe("New");
		expect(next.owner).toBe("raft:s1:agent:abc");
		expect(next.inboxNotify).toEqual(routing);
	});
});

describe("same-server + allowlist sender gate", () => {
	it("treats two raft owners on the same server as allowed, humans included", () => {
		expect(sameServerOwners("raft:s1:agent:abc", "raft:s1:human:artin")).toBe(true);
		expect(sameServerOwners("raft:s1:agent:abc", "raft:s2:agent:abc")).toBe(false);
		expect(sameServerOwners("raft:s1:agent:abc", null)).toBe(false);
	});
	it("matches full addresses and domains on the extra allowlist", () => {
		expect(parseAllowList([" Gmail.com ", "", "@botiverse.dev"])).toEqual(["gmail.com", "@botiverse.dev"]);
		expect(fromOnAllowList("a@gmail.com", ["gmail.com"])).toBe(true);
		expect(fromOnAllowList("a@gmail.com", ["@gmail.com"])).toBe(true);
		expect(fromOnAllowList("alice@x.test", ["alice@x.test"])).toBe(true);
		expect(fromOnAllowList("eve@x.test", ["alice@x.test"])).toBe(false);
	});
});

describe("decideNotify", () => {
	const owner = "raft:s1:agent:agent-uuid";
	const sameServerSender = "raft:s1:human:artin";
	it("notifies an agent owner when routing matches and the sender is on the same server", () => {
		expect(decideNotify({ owner, routing, senderOwner: sameServerSender, from: "artin@mail.build" }))
			.toEqual({ action: "notify", routing });
	});
	it("skips an off-server or unknown sender unless the extra allowlist matches", () => {
		expect(decideNotify({ owner, routing, from: "eve@evil.test" })).toEqual({
			action: "skip", reason: "sender_not_allowed",
		});
		expect(decideNotify({
			owner, routing, senderOwner: "raft:other:agent:x", from: "x@mail.build",
		})).toEqual({ action: "skip", reason: "sender_not_allowed" });
		expect(decideNotify({
			owner, routing, from: "alerts@pager.test", allowList: ["pager.test"],
		})).toEqual({ action: "notify", routing });
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
