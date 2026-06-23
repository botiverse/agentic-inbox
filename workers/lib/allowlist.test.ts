import { describe, it, expect } from "vitest";
import { parseDomains, domainOf, isAddressAllowed } from "./allowlist";

describe("parseDomains", () => {
	it("splits, trims, lowercases and drops empties", () => {
		expect(parseDomains("mail.build")).toEqual(["mail.build"]);
		expect(parseDomains(" Mail.Build , Example.COM ,")).toEqual(["mail.build", "example.com"]);
	});
	it("returns [] for empty/undefined", () => {
		expect(parseDomains("")).toEqual([]);
		expect(parseDomains(undefined)).toEqual([]);
	});
});

describe("domainOf", () => {
	it("extracts the lowercased domain", () => {
		expect(domainOf("Pai-Onboard-Daily-031@Mail.Build")).toBe("mail.build");
	});
	it("returns empty string for malformed input", () => {
		expect(domainOf("not-an-email")).toBe("");
	});
});

describe("isAddressAllowed", () => {
	const domains = ["mail.build"];

	it("allows an address under a configured domain (dynamic self-service, no redeploy)", () => {
		// Not in the literal allowlist, but its domain is configured.
		expect(isAddressAllowed("postel-e2e-123@mail.build", [], domains)).toBe(true);
	});

	it("allows an explicitly allowlisted address even when its domain is not configured", () => {
		expect(isAddressAllowed("legacy@other.com", ["legacy@other.com"], domains)).toBe(true);
	});

	it("is case-insensitive on both address and allowlist", () => {
		expect(isAddressAllowed("Pai-031@Mail.Build", [], ["MAIL.BUILD"])).toBe(true);
		expect(isAddressAllowed("LEGACY@OTHER.COM", ["legacy@other.com"], [])).toBe(true);
	});

	it("rejects an address whose domain is not configured and is not allowlisted", () => {
		expect(isAddressAllowed("attacker@evil.com", ["legacy@other.com"], domains)).toBe(false);
	});

	it("rejects when no allowlist and no domains are configured", () => {
		expect(isAddressAllowed("anyone@mail.build", [], [])).toBe(false);
	});

	it("backwards-compat: existing literal QA mailbox still allowed", () => {
		expect(isAddressAllowed("pai-onboard-daily-001@mail.build", ["pai-onboard-daily-001@mail.build"], [])).toBe(true);
	});
});
