import { describe, it, expect } from "vitest";
import { looksLikeHtml, stripHtmlToText, decodeHtmlEntities } from "./email-helpers";

describe("stripHtmlToText entity decoding (dogfood: Duoyu/Maggie)", () => {
	it("decodes &amp; in a URL so extracted links are usable", () => {
		const html = '<a href="x">https://example.com/verify?token=abc123&amp;uid=42&amp;src=email</a>';
		expect(stripHtmlToText(html)).toBe("https://example.com/verify?token=abc123&uid=42&src=email");
	});
	it("decodes entities in codes so grep matches (AT&T)", () => {
		expect(stripHtmlToText("<p>Code: AT&amp;T-9931</p>")).toBe("Code: AT&T-9931");
	});
	it("turns &nbsp; into normal space and collapses whitespace", () => {
		expect(stripHtmlToText("<p>a&nbsp;&nbsp;b</p>")).toBe("a b");
	});
	it("decodes numeric (decimal + hex) entities", () => {
		expect(decodeHtmlEntities("&#39;quote&#39; and &#x2014;dash")).toBe("'quote' and —dash");
	});
	it("decodes each entity token once (double-encoded stays literal)", () => {
		expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
	});
	it("leaves unknown/invalid entities untouched", () => {
		expect(decodeHtmlEntities("&notanentity; &#0; plain")).toBe("&notanentity; &#0; plain");
	});
	it("still drops script/style bodies (no leak) before decoding", () => {
		expect(stripHtmlToText('<script>var s="LEAK9271"</script><p>visible</p>')).toBe("visible");
		expect(stripHtmlToText("<style>.x{color:red}</style><p>ok</p>")).toBe("ok");
	});
});

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
