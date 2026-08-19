import { describe, it, expect } from "vitest";
import { deliveryMailbox, sameMailbox, receivedAtAddress } from "./addresses";

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

describe("receivedAtAddress (reply AS the alias they wrote to — artin's call)", () => {
	const me = "artin@mail.build";

	it("returns the +tag address the message was actually sent to", () => {
		expect(receivedAtAddress("artin+shop@mail.build", me)).toBe("artin+shop@mail.build");
	});

	it("picks OUR address out of a multi-recipient list, ignoring everyone else", () => {
		expect(receivedAtAddress("someone@elsewhere.example, artin+news@mail.build, other@x.test", me))
			.toBe("artin+news@mail.build");
	});

	it("tolerates the `Name <addr>` display form", () => {
		expect(receivedAtAddress('"Artin" <artin+shop@mail.build>', me)).toBe("artin+shop@mail.build");
	});

	it("normalizes case", () => {
		expect(receivedAtAddress("Artin+Shop@Mail.Build", me)).toBe("artin+shop@mail.build");
	});

	it("falls back to the bare mailbox when we are not in the list (e.g. Bcc)", () => {
		expect(receivedAtAddress("someone@elsewhere.example", me)).toBe(me);
		expect(receivedAtAddress("", me)).toBe(me);
		expect(receivedAtAddress(null, me)).toBe(me);
	});

	it("returns the plain address when the message was sent to it untagged", () => {
		expect(receivedAtAddress("artin@mail.build", me)).toBe("artin@mail.build");
	});
});
