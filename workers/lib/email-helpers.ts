// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared email helpers to eliminate duplication across API routes, MCP, and agent.
 *
 * Includes: DO stub helpers, sender validation, message-ID generation,
 * threading, HTML utilities, and tool-logic (getFullEmail / getFullThread).
 */
import type { MailboxDO } from "../durableObject";
import type { EmailFull } from "./schemas";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { formatQuotedDate } from "../../shared/dates";

// ── DO Stub ────────────────────────────────────────────────────────

/**
 * Resolve a MailboxDO stub from a mailbox email address.
 * Replaces the repeated 3-line ns.idFromName / ns.get pattern.
 */
export function getMailboxStub(
	env: Env,
	mailboxId: string,
): DurableObjectStub<MailboxDO> {
	const ns = env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	return ns.get(id);
}

// ── Mailbox Listing ────────────────────────────────────────────────

/**
 * List all mailboxes from R2 bucket metadata.
 */
export async function listMailboxes(
	bucket: R2Bucket,
): Promise<{ id: string; email: string }[]> {
	const list = await bucket.list({ prefix: "mailboxes/" });
	return list.objects.map((obj) => {
		const id = obj.key.replace("mailboxes/", "").replace(".json", "");
		return { id, email: id };
	});
}

// ── Sender Validation ──────────────────────────────────────────────

/**
 * Normalise to/from addresses and validate the sender matches the mailbox.
 * Returns the normalised values or throws with a user-facing message.
 */
export function validateSender(
	to: string | string[],
	from: string | { email: string; name: string },
	mailboxId: string,
): { toStr: string; fromEmail: string; fromDomain: string } {
	const toStr = (Array.isArray(to) ? to.join(", ") : to).toLowerCase();
	const fromEmail = (typeof from === "string" ? from : from.email).toLowerCase();

	if (fromEmail !== mailboxId.toLowerCase()) {
		throw new SenderValidationError("From address must match the mailbox email address");
	}

	const fromDomain = fromEmail.split("@")[1];
	if (!fromDomain) {
		throw new SenderValidationError("Invalid sender email address");
	}

	return { toStr, fromEmail, fromDomain };
}

export class SenderValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SenderValidationError";
	}
}

// ── Message ID ─────────────────────────────────────────────────────

/**
 * Generate an internal UUID and a proper RFC 2822 Message-ID.
 */
export function generateMessageId(fromDomain: string): {
	messageId: string;
	outgoingMessageId: string;
} {
	const messageId = crypto.randomUUID();
	const outgoingMessageId = `${messageId}@${fromDomain}`;
	return { messageId, outgoingMessageId };
}

// ── Threading ──────────────────────────────────────────────────────

/**
 * Build the References chain and In-Reply-To from an original email.
 */
export function buildReferencesChain(original: EmailFull): {
	originalMsgId: string;
	references: string[];
	threadId: string;
} {
	const originalMsgId = original.message_id || original.id;
	let existingRefs: string[] = [];
	if (original.email_references) {
		try {
			existingRefs = JSON.parse(original.email_references);
		} catch {
			// Malformed JSON in email_references — treat as empty
		}
	}
	const references = [...existingRefs, originalMsgId].filter(Boolean);
	const threadId = original.thread_id || original.id;
	return { originalMsgId, references, threadId };
}

/**
 * Build threading headers (In-Reply-To + References) for the email binding.
 */
export function buildThreadingHeaders(
	originalMsgId: string,
	references: string[],
): Record<string, string> {
	return {
		"In-Reply-To": `<${originalMsgId}>`,
		...(references.length > 0
			? { References: references.map((r) => `<${r}>`).join(" ") }
			: {}),
	};
}

// ── Draft-follows-in_reply_to ──────────────────────────────────────

/**
 * If the given email is a draft with an in_reply_to, resolve the real original.
 * Used by reply/forward routes to avoid threading against the draft itself.
 */
export async function resolveOriginalEmail(
	stub: DurableObjectStub<MailboxDO>,
	email: EmailFull,
): Promise<EmailFull> {
	if (email.folder_id === Folders.DRAFT && email.in_reply_to) {
		const realOriginal = (await stub.getEmail(email.in_reply_to)) as EmailFull | null;
		if (realOriginal) return realOriginal;
	}
	return email;
}

// ── HTML Utilities ─────────────────────────────────────────────────

/**
 * Escape all five OWASP-recommended HTML special characters in plain text.
 * Safe for use in both text content and attribute contexts.
 */
export function escapeHtml(text: string): string {
	if (!text) return "";
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Convert plain text to a simple HTML block with preserved whitespace.
 * Uses both `white-space:pre-wrap` (modern clients) and `<br>` tags
 * (clients that strip inline styles, e.g. Outlook) as a belt-and-suspenders approach.
 */
export function textToHtml(text: string): string {
	if (!text) return "";
	const escaped = escapeHtml(text).replace(/\n/g, "<br>");
	return `<div style="white-space:pre-wrap">${escaped}</div>`;
}

/**
 * Strip HTML tags and normalize whitespace to produce plain text.
 * Removes <style> and <script> blocks first to avoid injecting their
 * content into the output.
 */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
	mdash: "—", ndash: "–", hellip: "…", copy: "©",
	reg: "®", trade: "™", rsquo: "’", lsquo: "‘",
	rdquo: "”", ldquo: "“", middot: "·", bull: "•",
	laquo: "«", raquo: "»", deg: "°", euro: "€", pound: "£",
};

/** Decode HTML entities (named + numeric dec/hex). Each &...; token is decoded
 * exactly once, so double-encoded text (e.g. `&amp;lt;`) stays literal (`&lt;`). */
export function decodeHtmlEntities(s: string): string {
	return s.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (match, ent: string) => {
		if (ent[0] === "#") {
			const code = ent[1] === "x" || ent[1] === "X"
				? parseInt(ent.slice(2), 16)
				: parseInt(ent.slice(1), 10);
			if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
				try { return String.fromCodePoint(code); } catch { return match; }
			}
			return match;
		}
		const named = NAMED_ENTITIES[ent.toLowerCase()];
		return named !== undefined ? named : match;
	});
}

export function stripHtmlToText(html: string): string {
	if (!html) return "";
	// Strip script/style (including their bodies) and tags, THEN decode entities —
	// otherwise `body_text` keeps literal `&amp;`/`&nbsp;`/etc., which breaks
	// grepping codes/links (dogfood: Duoyu/Maggie — e.g. a URL `…?a=1&amp;b=2`
	// extracts as `…&amp;b=2` = broken; `AT&amp;T-1` misses a grep for `AT&T-1`).
	// Decode after tag-stripping so decoded `<`/`>` can't reintroduce markup.
	const stripped = html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, " ");
	return decodeHtmlEntities(stripped).replace(/\s+/g, " ").trim();
}

/**
 * Format a date string for use in quoted reply blocks.
 * @deprecated Use `formatQuotedDate` from `shared/dates` directly.
 */
export const formatEmailDate = formatQuotedDate;

/**
 * Build a quoted reply block HTML string from original email data.
 */
export function buildQuotedReplyBlock(original: {
	date?: string;
	sender?: string;
	body?: string;
}): string {
	if (!original.body) return "";
	
	// HTML-escape sender and date to prevent injection
	const originalSender = escapeHtml(original.sender || "unknown");
	const originalDate = escapeHtml(formatEmailDate(original.date || ""));

	// Sanitize the body to plain text to prevent stored XSS.
	// The original HTML renders safely in the sandboxed iframe, but quoted
	// reply blocks are injected into the compose editor and outgoing emails
	// where raw HTML would execute. Convert to escaped plain text instead.
	const plainBody = stripHtmlToText(original.body);
	const bodyToQuote = escapeHtml(plainBody).replace(/\n/g, "<br>");

	return `<br><blockquote style="border-left: 2px solid #ccc; margin: 0; padding-left: 1em; color: #666;">On ${originalDate}, ${originalSender} wrote:<br><br>${bodyToQuote}</blockquote>`;
}

// ── Tool Logic (getFullEmail / getFullThread) ──────────────────────

type MailboxThreadReaderStub = {
	getThreadEmails: (threadId: string) => Promise<EmailFull[]>;
};

/**
 * Whether a stored body actually contains HTML. The DO keeps a single `body`
 * column that may hold either an HTML part or a plain-text part, so we detect
 * real markup: a closing tag, or an opening tag of a known HTML element. A plain
 * message that merely contains `<name>@host` must NOT count as HTML.
 */
export function looksLikeHtml(body: string): boolean {
	return /<\/[a-z][a-z0-9]*\s*>|<(?:div|p|br|a|span|table|tr|td|th|thead|tbody|h[1-6]|strong|b|em|i|u|ul|ol|li|img|body|html|head|style|font|blockquote|hr|pre|code|small|center)\b/i.test(
		body,
	);
}

/**
 * Fetch a single email and return it with both HTML and plain-text body.
 * `body_html` is null when the message has no HTML part (so callers can rely on
 * `body_html === null` meaning "plain-text only"); `body_text` is always the
 * HTML stripped to plain text. Returns null if the email is not found.
 */
export async function getFullEmail(
	stub: DurableObjectStub<MailboxDO>,
	emailId: string,
) {
	const email = (await stub.getEmail(emailId)) as EmailFull | null;
	if (!email) return null;

	const textBody = email.body ? stripHtmlToText(email.body) : "";
	// SECURITY: body_html is the RAW stored body — it must NOT be entity-decoded.
	// It is meant to be rendered; decoding a sender's escaped `&lt;script&gt;` back
	// into a live `<script>` would inject XSS into the render path. Entity decoding
	// (in stripHtmlToText) only ever runs on body_text/snippet, which are never
	// rendered as HTML. Do not "simplify" this to reuse the decoded value.
	// (dogfood: Duoyu.)
	const bodyHtml = email.body && looksLikeHtml(email.body) ? email.body : null;
	// getEmail's row has no snippet column (snippet is a list-query SUBSTR), so
	// derive a plain-text preview here — get-email advertised snippet but returned
	// none (dogfood: Duoyu).
	return { ...email, body_text: textBody, body_html: bodyHtml, snippet: textBody.slice(0, 300) };
}

/**
 * Fetch all emails in a thread with full bodies in a single DO call.
 * Uses `getThreadEmails` which runs 2 SQL queries (emails + attachments)
 * instead of the previous N+1 pattern (1 list query + N getEmail calls).
 */
export async function getFullThread(
	stub: DurableObjectStub<MailboxDO>,
	threadId: string,
) {
	const threadStub = stub as unknown as MailboxThreadReaderStub;
	const emails = await threadStub.getThreadEmails(threadId);

	const enriched = emails.map((email) => {
		const textBody = email.body ? stripHtmlToText(email.body) : "";
		return { ...email, body_text: textBody };
	});

	// Already sorted ASC by the DO query, but ensure consistency
	enriched.sort(
		(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
	);

	return { thread_id: threadId, message_count: enriched.length, messages: enriched };
}

/**
 * v0 send honors ONLY `to`/`subject`/`text`/`html`. Returns the list of
 * unsupported body fields (empty = OK to send). Two dogfood findings shaped this:
 *  - HuangSong: a meaningful unsupported field (in_reply_to/attachments/cc/…)
 *    must be rejected LOUD, never silently dropped while returning 202.
 *  - 跳虎: the `raft integration invoke` CLI merges a POST action's PATH param
 *    into the request BODY, so send-mail arrives with a redundant `mailboxId`
 *    that equals the path. That's a harmless plumbing echo, not meaningful data
 *    loss — tolerate it (Postel's law) when it matches `pathMailbox`; a
 *    `mailboxId` that DIFFERS from the path is still reported (guards misrouting).
 */
export function unsupportedSendFields(
	body: Record<string, unknown>,
	pathMailbox: string,
): string[] {
	const SUPPORTED = new Set(["to", "subject", "text", "html"]);
	return Object.keys(body).filter((k) => {
		if (SUPPORTED.has(k)) return false;
		if (k === "mailboxId" && String(body[k]).toLowerCase() === pathMailbox.toLowerCase()) return false;
		return true;
	});
}

/**
 * Build a clean plain-text snippet preview from a raw (possibly HTML) body prefix.
 * The list query passes `SUBSTR(body,1,N)`, which can cut mid-tag and leave a
 * dangling open tag (`…<img class="s`) that the complete-tag stripper can't
 * remove — so drop a trailing incomplete `<…` (no closing `>` before end) first,
 * THEN strip tags/entities, THEN truncate. Scoped to snippets on purpose: we do
 * NOT clip trailing `<` in full body_text. (AX: Yingjun — snippet fragments.)
 * Gogo's durable fix persists this at ingest; this is the shared strip semantic.
 */
export function cleanSnippet(raw: string | null | undefined, maxLen = 300): string {
	if (!raw) return "";
	return stripHtmlToText(raw.replace(/<[^>]*$/, "")).slice(0, maxLen);
}
