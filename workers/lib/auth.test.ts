import { describe, it, expect } from "vitest";
import {
	hashApiKey,
	ownerCanAccess,
	reservedHandleForLocalPart,
	reservedHandleForAddress,
	createAllowedByPrefix,
	mailboxAccessAllowed,
	ownerFromRaftUserinfo,
	maxMailboxesForPlan,
	canCreateMailbox,
	serverIdFromOwner,
	planForOwner,
	serverAllowed,
	claimAllowedForHandle,
	isReservedSystemLocalPart,
	classifyClaim,
} from "./auth";

describe("hashApiKey", () => {
	it("produces a stable 64-char sha-256 hex and never echoes the raw key", async () => {
		const h = await hashApiKey("aibx_secret123");
		expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(h).not.toContain("secret");
		expect(await hashApiKey("aibx_secret123")).toBe(h); // stable
		expect(await hashApiKey("aibx_other")).not.toBe(h); // distinct
	});
});

describe("ownerCanAccess", () => {
	it("admin can access any mailbox", () => {
		expect(ownerCanAccess("acct_a", "acct_b", true)).toBe(true);
		expect(ownerCanAccess(null, "acct_b", true)).toBe(true);
	});
	it("non-admin can access only their own", () => {
		expect(ownerCanAccess("acct_a", "acct_a", false)).toBe(true);
		expect(ownerCanAccess("acct_a", "acct_b", false)).toBe(false);
	});
	it("unauthenticated caller cannot access", () => {
		expect(ownerCanAccess(null, "acct_b", false)).toBe(false);
		expect(ownerCanAccess(undefined, undefined, false)).toBe(false);
	});
	it("legacy mailbox with no owner is not accessible to non-admins", () => {
		expect(ownerCanAccess("acct_a", null, false)).toBe(false);
		expect(ownerCanAccess("acct_a", undefined, false)).toBe(false);
	});
});

describe("reservedHandleForLocalPart / Address", () => {
	it("takes the prefix before the first hyphen, lowercased", () => {
		expect(reservedHandleForLocalPart("pai-onboard-daily-001")).toBe("pai");
		expect(reservedHandleForLocalPart("Gogo")).toBe("gogo");
		expect(reservedHandleForAddress("Pai-QA@Mail.Build")).toBe("pai");
		expect(reservedHandleForAddress("postel@mail.build")).toBe("postel");
	});
});

describe("createAllowedByPrefix (anti-squat)", () => {
	it("allows creating within your own reserved prefix", () => {
		expect(createAllowedByPrefix("pai", "pai", true)).toBe(true);
		expect(createAllowedByPrefix("pai-qa", "pai", true)).toBe(true);
		expect(createAllowedByPrefix("PAI-QA", "pai", true)).toBe(true);
	});
	it("blocks squatting another account's handle prefix", () => {
		// bob tries to create pai-evil@ ; "pai" is owned by another account
		expect(createAllowedByPrefix("pai-evil", "bob", true)).toBe(false);
		expect(createAllowedByPrefix("pai", "bob", true)).toBe(false);
	});
	it("allows a free name not reserved by anyone", () => {
		expect(createAllowedByPrefix("team-newsletter", "bob", false)).toBe(true);
	});
});

describe("mailboxAccessAllowed (scoped keys)", () => {
	const alice = "raft:s1:agent:alice";
	const bob = "raft:s1:agent:bob";
	const boxA = { id: "alice@mail.build", owner: alice };
	const boxA2 = { id: "alice-ci@mail.build", owner: alice };
	const boxB = { id: "bob@mail.build", owner: bob };

	it("admin scope accesses any mailbox", () => {
		expect(mailboxAccessAllowed({ owner: "local:admin", scope: "admin" }, boxB)).toBe(true);
	});
	it("mailbox-scoped key accesses ONLY its one mailbox", () => {
		const key = { owner: alice, scope: "alice@mail.build" };
		expect(mailboxAccessAllowed(key, boxA)).toBe(true);
		expect(mailboxAccessAllowed(key, boxA2)).toBe(false); // same owner, different box → denied
		expect(mailboxAccessAllowed(key, boxB)).toBe(false);
	});
	it("account-scoped key accesses all the owner's mailboxes but not others'", () => {
		const key = { owner: alice, scope: "account" };
		expect(mailboxAccessAllowed(key, boxA)).toBe(true);
		expect(mailboxAccessAllowed(key, boxA2)).toBe(true);
		expect(mailboxAccessAllowed(key, boxB)).toBe(false); // cross-owner denied
	});
	it("denies when mailbox is owner-less (non-admin)", () => {
		expect(mailboxAccessAllowed({ owner: alice, scope: "account" }, { id: "x@mail.build", owner: null })).toBe(false);
	});
});

describe("ownerFromRaftUserinfo", () => {
	it("derives raft:server:type:sub, trusting only type/sub/server_id", () => {
		expect(ownerFromRaftUserinfo({ type: "agent", sub: "abc", server_id: "s1", preferred_username: "Alice" } as any))
			.toBe("raft:s1:agent:abc");
		expect(ownerFromRaftUserinfo({ type: "human", sub: "h1", server_id: "s1" })).toBe("raft:s1:human:h1");
	});
	it("returns null when required claims missing", () => {
		expect(ownerFromRaftUserinfo({ type: "agent", sub: "abc" })).toBeNull();
		expect(ownerFromRaftUserinfo(null)).toBeNull();
	});
});

describe("tiering / quota", () => {
	it("free = 1 mailbox; pro = 10 (tygg 2026-07-14)", () => {
		expect(maxMailboxesForPlan("free")).toBe(1);
		expect(maxMailboxesForPlan("pro")).toBe(10);
		expect(maxMailboxesForPlan(undefined)).toBe(1); // default to free
		expect(maxMailboxesForPlan("mystery")).toBe(1); // unknown plan → free
	});
	it("canCreateMailbox gates free at 1, pro at 10", () => {
		expect(canCreateMailbox("free", 0)).toBe(true);
		expect(canCreateMailbox("free", 1)).toBe(false); // 2nd mailbox blocked
		expect(canCreateMailbox("pro", 9)).toBe(true);
		expect(canCreateMailbox("pro", 10)).toBe(false); // 11th blocked
	});
});

describe("plan by raft-server tier", () => {
	it("extracts server_id from owner id", () => {
		expect(serverIdFromOwner("raft:s-123:agent:abc")).toBe("s-123");
		expect(serverIdFromOwner("local:admin")).toBeNull();
		expect(serverIdFromOwner(null)).toBeNull();
	});
	it("owner on a pro server → pro (10); else free (1)", () => {
		expect(planForOwner("raft:s-pro:agent:a", ["s-pro"])).toBe("pro");
		expect(planForOwner("raft:s-free:agent:a", ["s-pro"])).toBe("free");
		expect(planForOwner("raft:s-free:agent:a", [])).toBe("free");
	});
});

describe("claimAllowedForHandle (v0 anti-squat)", () => {
	it("allows claiming within your own handle namespace", () => {
		expect(claimAllowedForHandle("postel", "postel")).toBe(true);
		expect(claimAllowedForHandle("postel-ci", "postel")).toBe(true);
		expect(claimAllowedForHandle("PostEl-QA", "postel")).toBe(true);
	});
	it("blocks squatting another agent's handle", () => {
		expect(claimAllowedForHandle("gogo", "postel")).toBe(false); // A can't take B's name
		expect(claimAllowedForHandle("gogo-x", "postel")).toBe(false);
	});
	it("blocks reserved system names even for a matching-looking handle", () => {
		expect(claimAllowedForHandle("admin", "admin")).toBe(false);
		expect(claimAllowedForHandle("postmaster", "postmaster")).toBe(false);
	});
	it("requires a caller handle", () => {
		expect(claimAllowedForHandle("postel", "")).toBe(false);
	});
	it("allows a HYPHENATED handle to claim its own namespace (dogfood: Gogo, human-side)", () => {
		// Regression: the old fold-to-first-segment check made any hyphenated handle
		// unable to claim ANYTHING (gogo-signup-dogfood folded to gogo != full handle).
		expect(claimAllowedForHandle("gogo-signup-dogfood", "gogo-signup-dogfood")).toBe(true);
		expect(claimAllowedForHandle("gogo-signup-dogfood-notes", "gogo-signup-dogfood")).toBe(true);
		expect(claimAllowedForHandle("Gogo-Signup-Dogfood", "gogo-signup-dogfood")).toBe(true);
	});
	it("a hyphenated handle still can't claim a different (shorter) handle's bare name", () => {
		expect(claimAllowedForHandle("gogo", "gogo-signup-dogfood")).toBe(false);
		expect(claimAllowedForHandle("gogo-ci", "gogo-signup-dogfood")).toBe(false);
	});
	it("isReservedSystemLocalPart flags infra names, case-insensitive", () => {
		expect(isReservedSystemLocalPart("NoReply")).toBe(true);
		expect(isReservedSystemLocalPart("mailer-daemon")).toBe(true);
		expect(isReservedSystemLocalPart("postel")).toBe(false);
	});
});

describe("classifyClaim (adopt-on-claim disposition)", () => {
	const me = "raft:s1:agent:me";
	const other = "raft:s1:agent:other";
	it("creates when the mailbox does not exist", () => {
		expect(classifyClaim(false, null, me)).toBe("create");
		expect(classifyClaim(false, undefined, me)).toBe("create");
	});
	it("is idempotent when you already own it", () => {
		expect(classifyClaim(true, me, me)).toBe("idempotent");
	});
	it("is taken when someone else owns it", () => {
		expect(classifyClaim(true, other, me)).toBe("taken");
	});
	it("adopts an ownerless (orphan) mailbox", () => {
		// The 7/13 admin-provisioned canonical <handle>@ addresses: exist, no owner.
		expect(classifyClaim(true, null, me)).toBe("adopt");
		expect(classifyClaim(true, undefined, me)).toBe("adopt");
		expect(classifyClaim(true, "", me)).toBe("adopt");
	});
});

describe("serverAllowed (botiverse-only login gate)", () => {
	it("empty allowlist = unrestricted", () => {
		expect(serverAllowed("s-any", [])).toBe(true);
	});
	it("gates login to allowed servers", () => {
		expect(serverAllowed("s-botiverse", ["s-botiverse"])).toBe(true);
		expect(serverAllowed("s-other", ["s-botiverse"])).toBe(false);
		expect(serverAllowed(null, ["s-botiverse"])).toBe(false);
	});
});
