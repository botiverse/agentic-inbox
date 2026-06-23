import { describe, it, expect } from "vitest";
import {
	hashApiKey,
	ownerCanAccess,
	reservedHandleForLocalPart,
	reservedHandleForAddress,
	createAllowedByPrefix,
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
