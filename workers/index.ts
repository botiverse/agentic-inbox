// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
	getFullEmail,
	unsupportedSendFields,
	cleanSnippet,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { parseDomains, isAddressAllowed } from "./lib/allowlist";
import { maxMailboxesForPlan, planForOwner, claimAllowedForHandle, classifyClaim, asciiNamespaceForHandle, isValidAsciiLocalPart } from "./lib/auth";
import { mintKey, mintToken, recordOwnedMailbox, removeOwnedMailbox, rotateKey, listOwnerKeys, revokeOwnerKey, keyGuidance } from "./lib/keyRegistry";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	// Relaxed from .email() so a non-ASCII / malformed address returns an
	// actionable, namespace-aware 400 (with the caller's derived namespace)
	// instead of a bare zod error the caller can't act on (AX: 跳虎).
	email: z.string().min(1),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
// Also guard the bare single-mailbox routes (GET/PUT settings, DELETE) — the
// `/*` pattern above only matches sub-paths, so without this a scoped-key caller
// could read/modify/delete a mailbox they don't own.
app.use("/api/v1/mailboxes/:mailboxId", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	return c.json({ domains, emailAddresses });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const owner = c.get("authOwner");
	const isAdmin = c.get("authIsAdmin") === true;
	// FAIL CLOSED: only a verified admin sees every mailbox. Anyone else sees ONLY
	// their own (empty if none). Previously the fallback returned ALL mailboxes for
	// any request without a clean owner — a fail-open leak that would expose the
	// whole directory if the identity ever failed to attach.
	if (!isAdmin) {
		if (!owner) return c.json([]);
		// Strongly-consistent list from the per-owner DO (no kv.list lag, so a
		// just-claimed mailbox shows immediately — dogfood: Box).
		const ownerStub = c.env.OWNER.get(c.env.OWNER.idFromName(owner));
		const owned = await ownerStub.list(owner);
		return c.json(owned.map(({ email, name }) => ({ id: email, email, name })));
	}
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	let parsed: z.infer<typeof CreateMailboxBody>;
	try {
		parsed = CreateMailboxBody.parse(await c.req.json());
	} catch (e) {
		// Invalid JSON or schema violation (e.g. non-email `email`, missing `name`).
		// Return a clean 400 instead of letting the error surface as a 500.
		const detail = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "malformed request body";
		return c.json({ error: `Invalid request body: ${detail}`, code: "BAD_REQUEST" }, 400);
	}
	const { name, settings, email: rawEmail } = parsed;
	const email = rawEmail.toLowerCase();

	// Address shape + local-part must be ASCII (mail.build only issues ASCII
	// addresses). Validated BEFORE auth so malformed input returns a clean 400
	// (not a 500 or an auth 401 that hides the real problem). The caller's
	// namespace is derived here so every rejection can name the exact address
	// they CAN claim — crucial for non-ASCII-handle agents, who otherwise hit a
	// dead-end 400/403 with no path (AX: 跳虎). `handle` is present only when
	// authenticated, so an unauthenticated caller just gets the bare shape error.
	const handle = c.get("authHandle");
	const namespace = handle ? asciiNamespaceForHandle(handle) : "";
	const derivedNs = !!handle && namespace !== handle.toLowerCase();
	const nsHint = namespace
		? (derivedNs
			? ` Your handle "${handle}" has no ASCII email form, so your claimable namespace is derived: ${namespace}@mail.build (or ${namespace}-<suffix>@mail.build).`
			: ` Your claimable namespace is ${namespace}@mail.build (or ${namespace}-<suffix>@mail.build).`)
		: "";
	const atIdx = email.indexOf("@");
	const localPart = atIdx > 0 ? email.slice(0, atIdx) : "";
	if (atIdx < 1 || email.indexOf("@") !== email.lastIndexOf("@") || !email.slice(atIdx + 1)) {
		return c.json({ error: `email must be a single address of the form <local-part>@<domain>.${nsHint}`, code: "BAD_REQUEST", namespace: namespace || undefined }, 400);
	}
	if (!isValidAsciiLocalPart(localPart)) {
		return c.json({ error: `Mailbox local-part must be ASCII (letters, digits, . _ -).${nsHint}`, code: "INVALID_LOCALPART", namespace: namespace || undefined }, 400);
	}

	// Claim requires an authenticated owner (agent scoped key or human session).
	const owner = c.get("authOwner");
	if (!owner) return c.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
	const isAdmin = c.get("authIsAdmin") === true;

	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	const allowedDomains = parseDomains(c.env.DOMAINS);
	// Allow creation if the address is explicitly allowlisted OR under a configured
	// domain (dynamic self-service). If neither EMAIL_ADDRESSES nor DOMAINS is
	// configured, fall through unrestricted to preserve upstream behaviour.
	if (
		(allowedAddresses.length > 0 || allowedDomains.length > 0) &&
		!isAddressAllowed(email, allowedAddresses, allowedDomains)
	) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES or DOMAINS", code: "ADDRESS_NOT_ALLOWED" }, 403);
	}

	// Anti-squat: non-admin callers may only claim within their own handle
	// namespace (`<namespace>@` / `<namespace>-*`), never a reserved system name.
	// Prevents agent A from claiming B's identity address.
	if (!isAdmin) {
		if (!handle || !claimAllowedForHandle(localPart, namespace)) {
			return c.json({
				error: `You can only claim mailboxes under your own namespace, and reserved system names are not allowed.${nsHint}`,
				code: "NAMESPACE_FORBIDDEN",
				namespace: namespace || undefined,
			}, 403);
		}
	}

	// Existence check runs BEFORE the quota gate: re-claiming a mailbox you
	// already own is idempotent (never blocked by quota), a taken address is
	// rejected cleanly, and an ownerless mailbox is adopted rather than 409'd.
	const key = `mailboxes/${email}.json`;
	const existingObj = await c.env.BUCKET.get(key);
	let existingSettings: (Record<string, unknown> & { owner?: string; fromName?: string }) | null = null;
	if (existingObj) {
		existingSettings = (await existingObj.json()) as Record<string, unknown> & { owner?: string; fromName?: string };
		// Ownership disposition. Anti-squat namespace already enforced above, so an
		// "adopt" here only ever covers the caller's own ownerless address (e.g. an
		// admin-provisioned canonical <handle>@). (dogfood: Gogo/Box — 7/13 orphans.)
		const action = classifyClaim(true, existingSettings.owner, owner);
		if (action === "idempotent") {
			// Already yours — no new key minted.
			return c.json({ id: email, email, name: existingSettings.fromName || name, owner, settings: existingSettings }, 200);
		}
		if (action === "taken") {
			return c.json({ error: "Mailbox already exists and is owned by another account", code: "MAILBOX_TAKEN" }, 409);
		}
		// action === "adopt": fall through.
	}

	const adopting = existingSettings !== null;
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	// Adoption preserves the existing mailbox settings (and its stored mail);
	// a fresh claim starts from defaults. Either way `owner` is stamped as the
	// source of truth for API access scoping.
	const finalSettings = adopting
		? { ...(existingSettings as Record<string, unknown>), owner }
		: { ...defaultSettings, ...settings, owner };
	const displayName = (finalSettings as { fromName?: string }).fromName || name;

	// Tier quota (a fresh claim OR an orphan adoption both consume a slot). This
	// is an ATOMIC check-and-reserve in the per-owner DO — strongly consistent, so
	// two rapid claims can't both slip past the limit (dogfood: Cardy — the old
	// kv.list count lagged ~60s and let a 3rd mailbox through on free=1). Admin
	// gets an effectively unlimited allowance but is still recorded.
	const plan = planForOwner(owner, parseDomains(c.env.PRO_SERVER_IDS));
	const limit = isAdmin ? Number.MAX_SAFE_INTEGER : maxMailboxesForPlan(plan);
	const ownerStub = c.env.OWNER.get(c.env.OWNER.idFromName(owner));
	const reservation = await ownerStub.reserve(owner, email, displayName, limit);
	if (!reservation.ok) {
		return c.json({ error: `Mailbox quota reached for plan '${plan}'`, code: "QUOTA_EXCEEDED", plan, owned: reservation.owned }, 403);
	}

	try {
		await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
		const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
		await stub.getFolders();
	} catch (e) {
		// Don't leak a reserved slot if provisioning fails after reserving.
		await ownerStub.release(owner, email).catch(() => {});
		throw e;
	}
	// Keep the legacy KV index in sync (seed source / backfill safety net; the DO
	// is the count+list authority).
	await recordOwnedMailbox(c.env, owner, email, displayName);

	// Mint a mailbox-scoped access key — returned ONCE (finest isolation: this
	// key can only touch this one mailbox).
	const token = mintToken();
	const { hash: keyId } = await mintKey(c.env, { owner, scope: email, token, label: `mailbox ${email}`, now: new Date().toISOString() });

	// Never hand out a bare credential — ship onboarding guidance with the key.
	// `keyId` is the handle for revoke (DELETE .../keys/{id}) so the caller can
	// revoke the key it just got in one step, without a list-keys round-trip
	// (AX: HuangSong — claim/rotate returned the raw key but not its id).
	return c.json({ id: email, email, name: displayName, owner, settings: finalSettings, key: token, keyId, key_guidance: keyGuidance(email), adopted: adopting || undefined }, adopting ? 200 : 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c: AppContext) => {
	// Ownership is enforced by requireMailbox; release the quota slot so the owner
	// can reclaim it (dogfood: Duoyu — testers had no way to free a slot / clean up
	// residue, so each trial permanently burned a mailbox against the quota).
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	const owner = c.get("authOwner");
	if (owner) {
		const ownerStub = c.env.OWNER.get(c.env.OWNER.idFromName(owner));
		await ownerStub.release(owner, mailboxId);
		await removeOwnedMailbox(c.env, owner, mailboxId);
	}
	return c.body(null, 204);
});

// -- Mailbox access keys (rotate / list / revoke) -------------------
// All under requireMailbox, so the caller must own :mailboxId. Keys are scoped to
// the mailbox; the raw token is only ever returned once (mint/rotate).

// Rotate the mailbox key: mint a fresh one (returned once) + revoke the old.
app.post("/api/v1/mailboxes/:mailboxId/keys/rotate", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const owner = c.get("authOwner");
	if (!owner) return c.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
	const token = mintToken();
	const { hash: keyId, revoked } = await rotateKey(c.env, { owner, scope: mailboxId, token, label: `mailbox ${mailboxId}`, now: new Date().toISOString() });
	// Return `keyId` so the new key can be revoked in one step (no list-keys hop).
	return c.json({ id: mailboxId, email: mailboxId, key: token, keyId, key_guidance: keyGuidance(mailboxId), revoked }, 201);
});

// List this mailbox's key metadata — NEVER the raw token.
app.get("/api/v1/mailboxes/:mailboxId/keys", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const owner = c.get("authOwner");
	if (!owner) return c.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
	const keys = await listOwnerKeys(c.env, owner, mailboxId);
	return c.json({ keys });
});

// Revoke a specific key of this mailbox (owner-scoped by keyId).
app.delete("/api/v1/mailboxes/:mailboxId/keys/:keyId", async (c: AppContext) => {
	const owner = c.get("authOwner");
	if (!owner) return c.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
	// Pass the path mailbox as the expected scope so this route only revokes THIS
	// mailbox's key (path-scope consistency), not another mailbox's key.
	const ok = await revokeOwnerKey(c.env, owner, c.req.param("keyId")!, c.req.param("mailboxId")!);
	if (!ok) return c.json({ error: "Key not found", code: "NOT_FOUND" }, 404);
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	// The DO computes snippet as SUBSTR(body,1,300) = raw HTML for HTML mail, so
	// a UI/agent using it as a preview sees literal tags. Strip to plain text
	// (dogfood: Duoyu). body_text elsewhere is already stripped.
	//
	// SUBSTR can also cut mid-tag, leaving a DANGLING open tag at the end
	// (`…<img class="s`) that the complete-tag stripper (`<[^>]+>`) can't match, so
	// the fragment survives (AX: Yingjun). Drop a trailing incomplete `<…` (no
	// closing `>` before end) BEFORE stripping. Scoped to the snippet preview — we
	// deliberately do NOT do this in stripHtmlToText, which must not clip a
	// legitimate trailing `<` in full body_text. Interim: the durable fix persists
	// a stripped snippet column at ingest (Gogo, DO — schema thread pending).
	const stripSnippets = <T extends { snippet?: string | null }>(rows: T[]): T[] =>
		rows.map((e) => (e && e.snippet ? { ...e, snippet: cleanSnippet(e.snippet) } : e));

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails: stripSnippets(emails), totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails: stripSnippets(emails), totalCount });
	}
	return c.json(stripSnippets(emails));
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message, code: "BAD_REQUEST" }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError, code: "RATE_LIMITED" }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

// Internal-only send (v0): deliver from an owned mailbox to another mailbox on a
// configured domain by writing straight into the recipient's inbox — NO external
// SMTP egress, so no SPF/DKIM/DMARC/open-relay/spoofing surface. Owner-scoped
// (requireMailbox gates the FROM mailbox); the recipient mailbox must already
// exist. External outbound is a separate v0.1 with domain-auth + abuse controls.
app.post("/api/v1/mailboxes/:mailboxId/send", async (c: AppContext) => {
	const from = c.req.param("mailboxId")!.toLowerCase();
	let reqBody: { to?: string; subject?: string; text?: string; html?: string };
	try {
		reqBody = (await c.req.json()) as typeof reqBody;
	} catch {
		return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
	}
	// v0 send honors ONLY to/subject/text/html. Reject anything else LOUDLY
	// instead of silently dropping it (dogfood: HuangSong — in_reply_to/attachments
	// were silently ignored while the call still returned 202 "sent" = false
	// confidence). A redundant `mailboxId` echo that equals the path param is
	// tolerated (the `raft integration invoke` CLI merges a POST action's path
	// param into the body — dogfood: 跳虎; CLI root cause routed to Ray). See
	// unsupportedSendFields for the exact boundary (== path drop / ≠ path reject).
	if (typeof reqBody !== "object" || reqBody === null || Array.isArray(reqBody)) {
		return c.json({ error: "Request body must be a JSON object", code: "BAD_REQUEST" }, 400);
	}
	const unsupported = unsupportedSendFields(reqBody as Record<string, unknown>, from);
	if (unsupported.length > 0) {
		return c.json({ error: `Unsupported field(s): ${unsupported.join(", ")}. v0 send supports only to/subject/text/html — no threading (in_reply_to) or attachments yet.`, code: "UNSUPPORTED_FIELD", unsupported }, 400);
	}
	const to = (reqBody.to || "").trim().toLowerCase();
	if (!to || !/^[^@\s]+@[^@\s]+$/.test(to)) {
		return c.json({ error: "A valid `to` address is required", code: "BAD_REQUEST" }, 400);
	}
	// Internal-only: the recipient must be on a configured domain / allowlist.
	if (!isAddressAllowed(to, (c.env.EMAIL_ADDRESSES ?? []) as string[], parseDomains(c.env.DOMAINS))) {
		return c.json({ error: "v0 send is internal-only: the recipient must be a mailbox on a configured domain (e.g. @mail.build)", code: "SEND_EXTERNAL_UNSUPPORTED" }, 400);
	}
	// Recipient mailbox must already exist (internal delivery has no MX fallback).
	if (!(await c.env.BUCKET.head(`mailboxes/${to}.json`))) {
		return c.json({ error: "Recipient mailbox does not exist", code: "NOT_FOUND" }, 404);
	}
	const rateLimitError = await (c.var.mailboxStub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError, code: "RATE_LIMITED" }, 429);

	const subject = (reqBody.subject || "").toString();
	const content = (reqBody.html || reqBody.text || "").toString();
	const fromDomain = from.split("@")[1] || "mail.build";
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const now = new Date().toISOString();
	const common = {
		subject, sender: from, recipient: to, cc: null, bcc: null, date: now,
		body: content, in_reply_to: null, email_references: null,
		thread_id: messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: from }, { key: "to", value: to },
			{ key: "subject", value: subject }, { key: "date", value: now },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
			{ key: "x-agentic-inbox-delivery", value: "internal" },
		]),
	};
	// Deliver into the recipient's inbox, and keep a copy in the sender's Sent.
	const toStub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(to));
	await toStub.createEmail(Folders.INBOX, { id: messageId, ...common }, []);
	await c.var.mailboxStub.createEmail(Folders.SENT, { id: crypto.randomUUID(), ...common }, []);

	return c.json({ id: messageId, status: "sent", delivery: "internal" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (draft_id) await stub.deleteEmail(draft_id); // not atomic — create-then-delete would be safer
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId", async (c: AppContext) => {
	// Path param is `emailId` (was `id`) to match `mailboxId` — agents intuitively
	// tried `emailId` and hit an unhelpful "missing path parameter" (AX: Yingjun,
	// first production use). The manifest declares `{emailId}` in lockstep.
	const email = await getFullEmail(c.var.mailboxStub, c.req.param("emailId")!);
	if (!email) return c.json({ error: "Email not found", code: "NOT_FOUND" }, 404);
	// Stable agent-facing contract: `body_text` (HTML stripped to plain) and
	// `body_html` (null when the message has no HTML part) come from getFullEmail;
	// add `from`/`to` aliases over the stored `sender`/`recipient`.
	//
	// LEAN by default (AX: Yingjun — a verification email is ~8KB of HTML+headers
	// for ~60 bytes of signal, and agents pay tokens for every byte). The raw
	// `body` is redundant with body_html/body_text, and raw_headers is large and
	// rarely needed — both are DROPPED unless explicitly requested via
	// `?include=raw_body` / `?include=raw_headers` (comma-separated). The human UI
	// opts into both (it renders the raw body + a raw-headers dialog).
	const includes = new Set((c.req.query("include") || "").split(",").map((s) => s.trim()).filter(Boolean));
	const e = email as typeof email & { sender?: string; recipient?: string; body?: string | null; raw_headers?: string | null };
	const { body: rawBody, raw_headers: rawHeaders, ...lean } = e;
	const withContract: Record<string, unknown> = { ...lean, from: e.sender, to: e.recipient };
	if (includes.has("raw_body")) withContract.body = rawBody;
	if (includes.has("raw_headers")) withContract.raw_headers = rawHeaders;
	return c.json(withContract);
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(event: { raw: ReadableStream; rawSize: number }, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	if (!parsedEmail.to?.length || !parsedEmail.to[0].address) throw new Error("received email with empty to");

	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) => a.toLowerCase());
	const allowedDomains = parseDomains(env.DOMAINS);
	const allRecipients = parsedEmail.to.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	let mailboxId: string | undefined;
	if (allowedAddresses.length > 0 || allowedDomains.length > 0) {
		// Accept a recipient that is explicitly allowlisted OR under a configured domain.
		// Mailbox existence (checked below) remains the real delivery gate.
		mailboxId = allRecipients.find((addr) => isAddressAllowed(addr, allowedAddresses, allowedDomains));
		if (!mailboxId) { console.log(`Ignoring email: no recipient matches EMAIL_ADDRESSES or DOMAINS.`); return; }
	} else { mailboxId = allRecipients[0]; }
	if (!mailboxId) throw new Error("received email with no valid recipient address");

	const messageId = crypto.randomUUID();
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) { console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`); return; }

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	await stub.createEmail(Folders.INBOX, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
	}, attachmentData);

	// Built-in AI auto-draft is OPT-IN and OFF by default. Firing it on every
	// inbound email would (a) run Workers AI ~3-4× per message = a real cost driver,
	// and (b) conflict with the "no autonomous draft/write without explicit human
	// instruction" discipline (stdrc). Only fire when the mailbox explicitly enables
	// `autoDraft`. Direction is MCP-forward — a user's own agent manages the mail —
	// over a built-in model.
	const mboxObj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	const mboxSettings = mboxObj ? ((await mboxObj.json().catch(() => null)) as { autoDraft?: { enabled?: boolean } } | null) : null;
	if (mboxSettings?.autoDraft?.enabled === true) {
		const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
		ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId, emailId: messageId, sender: (parsedEmail.from?.address || "").toLowerCase(), subject: parsedEmail.subject || "", threadId }),
		})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));
	}
}

export { app, receiveEmail };
