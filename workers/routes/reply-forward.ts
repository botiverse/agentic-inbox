// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import { sendEmail } from "../email-sender";
import { AttachmentCleanupError, attachmentObjectKeys, discardAttachmentObjects, storeAttachments, type StoredAttachment } from "../lib/attachments";
import type { EmailFull } from "../lib/schemas";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
	resolveOriginalEmail,
} from "../lib/email-helpers";
import { SendEmailRequestSchema } from "../lib/schemas";
import { Folders } from "../../shared/folders";
import type { MailboxContext } from "../lib/mailbox";
import { flagContext, sendRateLimits } from "../lib/flags";
import { attachmentRecordBytes, chargeSessionWrite, rememberOrphans, storageQuotaResponse, storedMailBytes } from "../lib/accountStorage";

type AppContext = Context<MailboxContext>;
type RateLimitStub = { checkSendRateLimit: (limits?: { perHour: number; perDay: number }) => Promise<string | null> };

export async function handleReplyEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments } = body;

	const stub = c.var.mailboxStub;
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	const originalEmail = await resolveOriginalEmail(stub, rawOriginal);
	const { originalMsgId, references, threadId: thread_id } = buildReferencesChain(originalEmail);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimits = await sendRateLimits(c.env.FLAGS, flagContext(c.get("authOwner"), mailboxId));
	const rateLimitError = await (stub as unknown as RateLimitStub)
		.checkSendRateLimit(rateLimits);
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	const sentAt = new Date().toISOString();
	const ccStored = cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null;
	const bccStored = bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null;
	const replyHeaders = JSON.stringify([
		{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
		{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
		...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
		...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
		{ key: "subject", value: subject },
		{ key: "date", value: sentAt },
		{ key: "message-id", value: `<${outgoingMessageId}>` },
		...(originalMsgId ? [{ key: "in-reply-to", value: `<${originalMsgId}>` }] : []),
		...(references.length > 0 ? [{ key: "references", value: references.map((r: string) => `<${r}>`).join(" ") }] : []),
	]);
	const held = await chargeSessionWrite(
		c,
		mailboxId,
		storedMailBytes(html || text || "", (attachments ?? []).reduce((sum, att) => sum + attachmentRecordBytes({
			size: atob(att.content).length, filename: att.filename, mimetype: att.type, contentId: att.contentId, disposition: att.disposition,
		}), 0), subject, {
			sender: fromEmail, recipient: toStr, cc: ccStored, bcc: bccStored, date: sentAt,
			inReplyTo: originalMsgId, references: JSON.stringify(references), threadId: thread_id,
			messageId: outgoingMessageId, rawHeaders: replyHeaders,
		}),
	);
	if (!held.ok) return storageQuotaResponse(held);
	let stored = false;
	let attachmentData: StoredAttachment[] | undefined;
	try {
	attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: ccStored,
			bcc: bccStored,
			date: sentAt,
			body: html || text || "",
			in_reply_to: originalMsgId,
			email_references: JSON.stringify(references),
			thread_id: thread_id,
			message_id: outgoingMessageId,
			raw_headers: replyHeaders,
		},
		attachmentData,
	);
	stored = true;

	await stub.markThreadRead(thread_id);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to,
			cc,
			bcc,
			from,
			subject,
			html,
			text,
			attachments: attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				contentId: att.contentId,
			})),
			headers: buildThreadingHeaders(originalMsgId, references),
		}).catch((e) => {
			console.error("Deferred reply delivery failed:", (e as Error).message);
		}),
	);

	await held.commit();
	return c.json({ id: messageId, status: "sent" }, 202);
	} catch (e) {
		let keepCharge = e instanceof AttachmentCleanupError;
		const orphanKeys: string[] = e instanceof AttachmentCleanupError ? [...e.keys] : [];
		if (!stored && !keepCharge && attachmentData?.length) {
			try {
				await discardAttachmentObjects(c.env.BUCKET, messageId, attachmentData);
			} catch (cleanupErr) {
				console.error("attachment cleanup failed:", (cleanupErr as Error).message);
				keepCharge = true;
				orphanKeys.push(...attachmentObjectKeys(messageId, attachmentData));
			}
		}
		if (!stored && keepCharge && orphanKeys.length > 0) {
			await rememberOrphans(c.env, held.owner, orphanKeys, held.bytes, held.id).catch((err) => {
				console.error("orphan record failed:", (err as Error).message);
			});
		}
		if (!stored && !keepCharge) await held.release();
		throw e;
	}
}

export async function handleForwardEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments } = body;

	const stub = c.var.mailboxStub;
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	await resolveOriginalEmail(stub, rawOriginal);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimits = await sendRateLimits(c.env.FLAGS, flagContext(c.get("authOwner"), mailboxId));
	const rateLimitError = await (stub as unknown as RateLimitStub)
		.checkSendRateLimit(rateLimits);
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	const sentAt = new Date().toISOString();
	const ccStored = cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null;
	const bccStored = bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null;
	const forwardHeaders = JSON.stringify([
		{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
		{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
		...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
		...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
		{ key: "subject", value: subject },
		{ key: "date", value: sentAt },
		{ key: "message-id", value: `<${outgoingMessageId}>` },
	]);
	const held = await chargeSessionWrite(
		c,
		mailboxId,
		storedMailBytes(html || text || "", (attachments ?? []).reduce((sum, att) => sum + attachmentRecordBytes({
			size: atob(att.content).length, filename: att.filename, mimetype: att.type, contentId: att.contentId, disposition: att.disposition,
		}), 0), subject, {
			sender: fromEmail, recipient: toStr, cc: ccStored, bcc: bccStored, date: sentAt,
			messageId: outgoingMessageId, rawHeaders: forwardHeaders,
		}),
	);
	if (!held.ok) return storageQuotaResponse(held);
	let stored = false;
	let attachmentData: StoredAttachment[] | undefined;
	try {
	attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: ccStored,
			bcc: bccStored,
			date: sentAt,
			body: html || text || "",
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: outgoingMessageId,
			raw_headers: forwardHeaders,
		},
		attachmentData,
	);
	stored = true;

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to,
			cc,
			bcc,
			from,
			subject,
			html,
			text,
			attachments: attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				contentId: att.contentId,
			})),
		}).catch((e) => {
			console.error("Deferred forward delivery failed:", (e as Error).message);
		}),
	);

	await held.commit();
	return c.json({ id: messageId, status: "sent" }, 202);
	} catch (e) {
		let keepCharge = e instanceof AttachmentCleanupError;
		const orphanKeys: string[] = e instanceof AttachmentCleanupError ? [...e.keys] : [];
		if (!stored && !keepCharge && attachmentData?.length) {
			try {
				await discardAttachmentObjects(c.env.BUCKET, messageId, attachmentData);
			} catch (cleanupErr) {
				console.error("attachment cleanup failed:", (cleanupErr as Error).message);
				keepCharge = true;
				orphanKeys.push(...attachmentObjectKeys(messageId, attachmentData));
			}
		}
		if (!stored && keepCharge && orphanKeys.length > 0) {
			await rememberOrphans(c.env, held.owner, orphanKeys, held.bytes, held.id).catch((err) => {
				console.error("orphan record failed:", (err as Error).message);
			});
		}
		if (!stored && !keepCharge) await held.release();
		throw e;
	}
}
