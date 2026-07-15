import { describe, it, expect } from "vitest";
import { looksLikeHtml } from "./email-helpers";

describe("looksLikeHtml (get-email body_html null semantics)", () => {
	it("is false for plain text (so body_html === null for text/plain-only mail)", () => {
		// Regression: dogfood (Bugen) — a text/plain verification email was returning
		// body_html = the raw plain text, breaking `body_html === null` as the
		// "no HTML part" signal.
		expect(looksLikeHtml("Your code is PST-563563\nVerify: https://mail.build/verify?token=x\n")).toBe(false);
		expect(looksLikeHtml("")).toBe(false);
		expect(looksLikeHtml("plain line one\nplain line two")).toBe(false);
	});

	it("does not treat bare angle-bracket tokens as HTML", () => {
		expect(looksLikeHtml("send to <name>@host for access")).toBe(false);
		expect(looksLikeHtml("use the <placeholder> value")).toBe(false);
	});

	it("is true for real HTML markup", () => {
		expect(looksLikeHtml('<div style="x"><h2>Hi</h2><p>body</p></div>')).toBe(true);
		expect(looksLikeHtml("line<br>next")).toBe(true);
		expect(looksLikeHtml('<a href="https://x">link</a>')).toBe(true);
		expect(looksLikeHtml("<!DOCTYPE html><html><body>x</body></html>")).toBe(true);
		expect(looksLikeHtml("text with a closing </span> tag")).toBe(true);
	});
});
