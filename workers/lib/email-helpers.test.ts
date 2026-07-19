import { describe, it, expect } from "vitest";
import { looksLikeHtml, stripHtmlToText, decodeHtmlEntities, getFullEmail, unsupportedSendFields, cleanSnippet } from "./email-helpers";

describe("getFullEmail body_html is raw (XSS guard — dogfood: Duoyu)", () => {
	// A sender safely-escaped `<script>` as display text. body_html is rendered,
	// so it MUST stay escaped; body_text is never rendered, so decoding is fine.
	const row = { id: "e1", body: "<p>&lt;script&gt;alert(1)&lt;/script&gt; hi</p>", read: 1, starred: 0 };
	const stub = { getEmail: async () => row } as never;

	it("keeps body_html entity-escaped (never decoded)", async () => {
		const full = await getFullEmail(stub, "e1");
		expect(full?.body_html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt; hi</p>");
		expect(full?.body_html).not.toContain("<script>");
	});

	it("decodes body_text (never rendered as HTML, so safe/grep-able)", async () => {
		const full = await getFullEmail(stub, "e1");
		expect(full?.body_text).toBe("<script>alert(1)</script> hi");
	});
});

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

describe("unsupportedSendFields (strict fields + tolerant path-echo — dogfood: HuangSong / 跳虎)", () => {
	const box = "postel@mail.build";

	it("accepts exactly to/subject/text/html", () => {
		expect(unsupportedSendFields({ to: "a@mail.build", subject: "s", text: "t" }, box)).toEqual([]);
		expect(unsupportedSendFields({ to: "a@mail.build", html: "<p>x</p>" }, box)).toEqual([]);
	});

	it("drops a redundant `mailboxId` that equals the path param (CLI POST path-echo)", () => {
		// The `raft integration invoke` CLI merges the POST path param into the body.
		expect(unsupportedSendFields({ mailboxId: "postel@mail.build", to: "a@mail.build", subject: "s", text: "t" }, box)).toEqual([]);
		// case-insensitive match (addresses are lower-cased at the handler)
		expect(unsupportedSendFields({ mailboxId: "Postel@Mail.Build", to: "a@mail.build" }, box)).toEqual([]);
	});

	it("STILL reports a `mailboxId` that differs from the path (guards misrouting)", () => {
		expect(unsupportedSendFields({ mailboxId: "someone-else@mail.build", to: "a@mail.build" }, box)).toEqual(["mailboxId"]);
	});

	it("STILL reports meaningful unsupported fields (never silently dropped)", () => {
		expect(unsupportedSendFields({ to: "a@mail.build", subject: "s", text: "t", in_reply_to: "x" }, box)).toEqual(["in_reply_to"]);
		expect(unsupportedSendFields({ to: "a@mail.build", attachments: [] }, box)).toEqual(["attachments"]);
		expect(unsupportedSendFields({ to: "a@mail.build", cc: "b@mail.build" }, box)).toEqual(["cc"]);
	});

	it("reports both a mismatched mailboxId and other unsupported fields together", () => {
		const out = unsupportedSendFields({ mailboxId: "other@mail.build", to: "a@mail.build", in_reply_to: "x" }, box);
		expect(out).toContain("mailboxId");
		expect(out).toContain("in_reply_to");
	});
});

describe("cleanSnippet (list preview — drops mid-tag truncation fragments — AX: Yingjun)", () => {
	it("drops a dangling incomplete tag left by SUBSTR mid-tag truncation", () => {
		// SUBSTR(body,1,N) cut inside an <img …> → `<img class="s` survives the
		// complete-tag stripper. cleanSnippet must not leak the fragment.
		expect(cleanSnippet('<p>Your code is 123456</p><img class="s')).toBe("Your code is 123456");
		expect(cleanSnippet('Hello world <div class="foo" styl')).toBe("Hello world");
	});
	it("strips complete tags + decodes entities like body_text", () => {
		expect(cleanSnippet("<p>a&amp;b</p>")).toBe("a&b");
		expect(cleanSnippet("<a href='https://x'>link</a> text")).toBe("link text");
	});
	it("leaves plain text intact; a trailing bare `<` is treated as a dangling tag", () => {
		expect(cleanSnippet("just plain text")).toBe("just plain text");
		expect(cleanSnippet("code ABC-123 first")).toBe("code ABC-123 first");
		// a trailing `<…` at the very end is stripped as a dangling tag — an
		// acceptable over-strip for a PREVIEW only (full body_text is untouched;
		// stripHtmlToText deliberately does not do this).
		expect(cleanSnippet("5 is < ")).toBe("5 is");
		// real HTML has `>` in complete tags, so only the trailing dangling tag goes:
		expect(cleanSnippet("<p>done</p><span sty")).toBe("done");
	});
	it("truncates to maxLen", () => {
		expect(cleanSnippet("x".repeat(500)).length).toBe(300);
		expect(cleanSnippet("abcdef", 3)).toBe("abc");
	});
	it("handles null/empty", () => {
		expect(cleanSnippet(null)).toBe("");
		expect(cleanSnippet("")).toBe("");
		expect(cleanSnippet(undefined)).toBe("");
	});
});
