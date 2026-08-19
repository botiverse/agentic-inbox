import { describe, it, expect } from "vitest";
import { deliveryMailbox, sameMailbox } from "./addresses";

describe("sameMailbox (one identity rule for delivery + compose — AX: artin)", () => {
	it("treats a +tag sub-address as the same mailbox", () => {
		// The reply-all bug this prevents: self-exclusion compared raw strings, so
		// mail addressed to your own +tag address was added as a recipient and you
		// emailed yourself. Only reachable once plus-addressed mail was delivered.
		expect(sameMailbox("artin+staging-smoke@mail.build", "artin@mail.build")).toBe(true);
		expect(sameMailbox("artin+a@mail.build", "artin+b@mail.build")).toBe(true);
	});
	it("ignores case and surrounding whitespace", () => {
		expect(sameMailbox("  Artin+Test@Mail.Build ", "artin@mail.build")).toBe(true);
	});
	it("does NOT merge genuinely different mailboxes", () => {
		expect(sameMailbox("artin@mail.build", "gogo@mail.build")).toBe(false);
		expect(sameMailbox("artin@mail.build", "artin@elsewhere.example")).toBe(false);
		// a hyphen sub-mailbox is a REAL separate mailbox, not a tag
		expect(sameMailbox("artin-ci@mail.build", "artin@mail.build")).toBe(false);
	});
	it("is false for empty input rather than matching everything", () => {
		expect(sameMailbox("", "artin@mail.build")).toBe(false);
		expect(sameMailbox("artin@mail.build", "")).toBe(false);
	});
});

describe("deliveryMailbox (shared definition)", () => {
	it("strips the tag for lookup", () => {
		expect(deliveryMailbox("artin+test@mail.build")).toBe("artin@mail.build");
	});
	it("leaves plain, tag-only and malformed addresses alone", () => {
		expect(deliveryMailbox("artin@mail.build")).toBe("artin@mail.build");
		expect(deliveryMailbox("+tag@mail.build")).toBe("+tag@mail.build");
		expect(deliveryMailbox("notanaddress")).toBe("notanaddress");
	});
});
