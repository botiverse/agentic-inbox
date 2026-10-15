// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the Agent and MCP server.
 *
 * Each function takes an `env: Env` (or a DO stub) and tool-specific params,
 * performs the business logic (DO calls, data fetching, formatting), and
 * returns a plain object. The Agent and MCP server wrap these results in
 * their own response formats.
 *
 * Functions that already exist in email-helpers.ts (getFullEmail, getFullThread)
 * are reused directly — this module covers the remaining shared operations.
 */

import type { EmailFull } from "./schemas";
import {
	getMailboxStub,
	getFullEmail,
	getFullThread,
	buildQuotedReplyBlock,
	textToHtml,
	listMailboxes,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
} from "./email-helpers";
import { verifyDraft } from "./ai";
import { sendEmail } from "../email-sender";
import { Folders } from "../../shared/folders";
import { flagContext, sendRateLimits } from "./flags";
import { AttachmentCleanupError, attachmentObjectKeys, discardAttachmentObjects } from "./attachments";
import { abortStorageDelete, accountOwner, beginStorageDelete, finishStorageDelete, holdMailboxBytes, rememberOrphans, storedMailBytes } from "./accountStorage";
import type { StoredMailFields } from "./storageQuota";
import type { Env } from "../types";

const STORAGE_QUOTA_ERROR = "Account storage quota exceeded. Delete mail to free space. Existing mail is kept.";

async function admitBody(env: Env, mailboxId: string, body: string, subject = "", fields: StoredMailFields = {}) {
	const hold = await holdMailboxBytes(env, mailboxId, storedMailBytes(body, 0, subject, fields));
	if (!hold.ok) return { ok: false as const, error: STORAGE_QUOTA_ERROR };
	return hold;
}



// ── Type casts for DO methods not on the base stub type ────────────
type MailboxSearchStub = {
	searchEmails: (options: {
		query: string;
		folder?: string;
	}) => Promise<unknown>;
};

type RateLimitStub = {
	checkSendRateLimit: (limits?: { perHour: number; perDay: number }) => Promise<string | null>;
};

// ── list_mailboxes ─────────────────────────────────────────────────

export async function toolListMailboxes(env: Env) {
	return listMailboxes(env.BUCKET);
}

// ── list_emails ────────────────────────────────────────────────────

export async function toolListEmails(
	env: Env,
	mailboxId: string,
	params: { folder: string; limit: number; page: number },
) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.getEmails({
		folder: params.folder,
		limit: params.limit,
		page: params.page,
		sortColumn: "date",
		sortDirection: "DESC",
	});
}

// ── get_email ──────────────────────────────────────────────────────

export async function toolGetEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await getFullEmail(stub, emailId);
	if (!email) return { error: "Email not found" };
	return email;
}

// ── get_thread ─────────────────────────────────────────────────────

export async function toolGetThread(
	env: Env,
	mailboxId: string,
	threadId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	return getFullThread(stub, threadId);
}

// ── search_emails ──────────────────────────────────────────────────

export async function toolSearchEmails(
	env: Env,
	mailboxId: string,
	params: { query: string; folder?: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	return (stub as unknown as MailboxSearchStub).searchEmails({
		query: params.query,
		folder: params.folder,
	});
}

// ── draft_reply ────────────────────────────────────────────────────

/**
 * Shared draft-reply logic.
 *
 * @param bodyInput - The reply body text. Can be plain text or HTML.
 * @param options.isPlainText - If true, body is treated as plain text and
 *   converted to HTML. If false, body is treated as HTML.
 * @param options.runVerifyDraft - If true, runs AI verifyDraft on the body.
 *   The agent and MCP both do this, but the agent does it on plain text
 *   while MCP does it on HTML.
 */
export async function toolDraftReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
	},
): Promise<
	| { status: "draft_saved"; draftId: string; message: string; draft: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Verify/sanitize if requested
	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	// Convert plain text to HTML if needed
	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Get the original email for thread_id and quoted text
	const original = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	const threadId = original?.thread_id || params.originalEmailId;

	// Append quoted original message
	const quotedBlock = original
		? buildQuotedReplyBlock({
				date: original.date,
				sender: original.sender || params.to,
				body: original.body ?? undefined,
			})
		: "";
	const bodyHtml = processedBody + quotedBlock;
	const draftedAt = new Date().toISOString();
	const hold = await admitBody(env, mailboxId, bodyHtml, params.subject, {
		sender: mailboxId.toLowerCase(),
		recipient: params.to.toLowerCase(),
		date: draftedAt,
		inReplyTo: params.originalEmailId,
		threadId,
	});
	if (!hold.ok) return hold;

	try {
	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: draftedAt,
			body: bodyHtml,
			in_reply_to: params.originalEmailId,
			email_references: null,
			thread_id: threadId,
		},
		[],
	);
	await hold.commit();

	return {
		status: "draft_saved",
		draftId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			originalEmailId: params.originalEmailId,
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : bodyHtml,
		},
	};
	} catch (e) {
		await hold.release();
		throw e;
	}
}

// ── draft_email (new email, not a reply) ───────────────────────────

export async function toolDraftEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
		/** Optional in_reply_to for create_draft style */
		in_reply_to?: string;
		/** Optional thread_id for create_draft style */
		thread_id?: string;
	},
): Promise<
	| { status: string; draftId: string; threadId?: string; message: string; draft?: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Resolve thread ID
	let resolvedThreadId = params.thread_id;
	if (!resolvedThreadId && params.in_reply_to) {
		const original = (await stub.getEmail(params.in_reply_to)) as EmailFull | null;
		resolvedThreadId = original?.thread_id || params.in_reply_to;
	}
	if (!resolvedThreadId) {
		resolvedThreadId = draftId;
	}

	const draftedAt = new Date().toISOString();
	const hold = await admitBody(env, mailboxId, processedBody, params.subject, {
		sender: mailboxId.toLowerCase(),
		recipient: (params.to || "").toLowerCase(),
		date: draftedAt,
		inReplyTo: params.in_reply_to,
		threadId: resolvedThreadId,
	});
	if (!hold.ok) return hold;
	try {
	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to || "").toLowerCase(),
			date: draftedAt,
			body: processedBody,
			in_reply_to: params.in_reply_to || null,
			email_references: null,
			thread_id: resolvedThreadId,
		},
		[],
	);
	await hold.commit();

	return {
		status: "draft_saved",
		draftId,
		threadId: resolvedThreadId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : processedBody,
		},
	};
	} catch (e) {
		await hold.release();
		throw e;
	}
}

// ── update_draft ───────────────────────────────────────────────────

export async function toolUpdateDraft(
	env: Env,
	mailboxId: string,
	params: {
		draftId: string;
		to?: string;
		subject?: string;
		bodyHtml?: string;
	},
): Promise<
	| { status: string; newDraftId: string; oldDraftId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const oldDraft = (await stub.getEmail(params.draftId)) as EmailFull | null;
	if (!oldDraft) {
		return { error: "Draft not found" };
	}

	// Verify the body BEFORE deleting the old draft to prevent data loss
	const newDraftId = crypto.randomUUID();
	const rawBody = params.bodyHtml ?? oldDraft.body ?? "";
	const verifiedBody = await verifyDraft(env.AI, rawBody);

	if (!verifiedBody) {
		return { error: "Draft verification failed — keeping existing draft unchanged. Please try again." };
	}

	const nextSubject = params.subject ?? oldDraft.subject ?? "";
	const draftedAt = new Date().toISOString();
	const recipient = (params.to ?? oldDraft.recipient).toLowerCase();
	const threadId = oldDraft.thread_id || newDraftId;
	const nextBytes = storedMailBytes(verifiedBody, 0, nextSubject, {
		sender: mailboxId.toLowerCase(),
		recipient,
		date: draftedAt,
		inReplyTo: oldDraft.in_reply_to,
		references: oldDraft.email_references,
		threadId,
	});
	const oldBytes = (await stub.measureEmailBytes(params.draftId)) ?? storedMailBytes(oldDraft.body, 0, oldDraft.subject ?? "", {
		sender: oldDraft.sender,
		recipient: oldDraft.recipient,
		cc: oldDraft.cc,
		bcc: oldDraft.bcc,
		date: oldDraft.date,
		inReplyTo: oldDraft.in_reply_to,
		references: oldDraft.email_references,
		threadId: oldDraft.thread_id,
		messageId: oldDraft.message_id,
		rawHeaders: oldDraft.raw_headers,
	});
	const owner = await accountOwner(env, mailboxId);
	const removal = oldBytes > 0 ? await beginStorageDelete(env, owner, oldBytes, `${mailboxId}/${params.draftId}`) : null;
	const hold = nextBytes > 0 ? await holdMailboxBytes(env, mailboxId, nextBytes, { deleteId: removal }) : null;
	if (hold && !hold.ok) {
		await abortStorageDelete(env, owner, removal);
		return { error: STORAGE_QUOTA_ERROR };
	}
	let deleted = false;
	let stored = false;
	try {
		const removed = await stub.deleteEmail(params.draftId);
		if (removed === null) {
			if (hold?.ok) await hold.release();
			await abortStorageDelete(env, owner, removal);
			return { error: "Draft was replaced concurrently" };
		}
		if (removed.length > 0) {
			try {
				await discardAttachmentObjects(env.BUCKET, params.draftId, removed);
			} catch (cleanupErr) {
				console.error("draft attachment cleanup failed:", (cleanupErr as Error).message);
				const keys = attachmentObjectKeys(params.draftId, removed);
				await rememberOrphans(env, owner, keys, oldBytes, undefined, removal).catch((err) => {
					console.error("orphan record failed:", (err as Error).message);
				});
				await abortStorageDelete(env, owner, removal);
				throw new AttachmentCleanupError((cleanupErr as Error).message, keys, oldBytes);
			}
		}
		deleted = true;
		await stub.createEmail(
			Folders.DRAFT,
			{
				id: newDraftId,
				subject: nextSubject,
				sender: mailboxId.toLowerCase(),
				recipient,
				date: draftedAt,
				body: verifiedBody,
				in_reply_to: oldDraft.in_reply_to || null,
				email_references: oldDraft.email_references || null,
				thread_id: threadId,
			},
			[],
		);
		stored = true;
		await finishStorageDelete(env, owner, removal);
		if (hold?.ok) await hold.commit();
	} catch (e) {
		const keepOld = e instanceof AttachmentCleanupError;
		if (!stored && deleted && !keepOld) await finishStorageDelete(env, owner, removal);
		else if (!stored) await abortStorageDelete(env, owner, removal);
		if (!stored && hold?.ok) await hold.release();
		if (keepOld) return { error: "Attachment cleanup failed. Storage quota was kept." };
		throw e;
	}

	return {
		status: "draft_updated",
		newDraftId,
		oldDraftId: params.draftId,
		message: "Draft updated in Drafts folder.",
	};
}

// ── mark_email_read ────────────────────────────────────────────────

export async function toolMarkEmailRead(
	env: Env,
	mailboxId: string,
	emailId: string,
	read: boolean,
) {
	const stub = getMailboxStub(env, mailboxId);
	await stub.updateEmail(emailId, { read });
	return { status: "updated", emailId, read };
}

// ── move_email ─────────────────────────────────────────────────────

export async function toolMoveEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	folderId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const success = await stub.moveEmail(emailId, folderId);
	if (success) {
		return { status: "moved", emailId, folder: folderId };
	}
	return { error: "Failed to move email" };
}

// ── discard_draft ──────────────────────────────────────────────────

export async function toolDiscardDraft(
	env: Env,
	mailboxId: string,
	draftId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(draftId)) as { folder_id?: string } | null;
	if (!email) {
		return { error: "Draft not found" };
	}
	if (email.folder_id !== Folders.DRAFT) {
		return { error: "Cannot discard: email is not a draft" };
	}
	const bytes = (await stub.measureEmailBytes(draftId)) ?? 0;
	const owner = await accountOwner(env, mailboxId);
	const deletion = await beginStorageDelete(env, owner, bytes, `${mailboxId}/${draftId}`);
	let removed!: Awaited<ReturnType<typeof stub.deleteEmail>>;
	try {
		removed = await stub.deleteEmail(draftId);
	} catch (e) {
		await abortStorageDelete(env, owner, deletion);
		throw e;
	}
	if (removed === null) {
		await abortStorageDelete(env, owner, deletion);
		return { status: "discarded", draftId };
	}
	if (removed.length > 0) {
		try {
			await discardAttachmentObjects(env.BUCKET, draftId, removed);
		} catch (e) {
			console.error("draft attachment cleanup failed:", (e as Error).message);
			await rememberOrphans(env, owner, attachmentObjectKeys(draftId, removed), bytes, undefined, deletion).catch((err) => {
				console.error("orphan record failed:", (err as Error).message);
			});
			await abortStorageDelete(env, owner, deletion);
			return { error: "Attachment cleanup failed. Storage quota was kept.", draftId };
		}
	}
	await finishStorageDelete(env, owner, deletion);
	return { status: "discarded", draftId };
}

// ── delete_email ───────────────────────────────────────────────────

export async function toolDeleteEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const bytes = await stub.measureEmailBytes(emailId);
	if (bytes === null) {
		return { error: "Email not found", emailId };
	}
	const owner = await accountOwner(env, mailboxId);
	const deletion = await beginStorageDelete(env, owner, bytes, `${mailboxId}/${emailId}`);
	let result!: Awaited<ReturnType<typeof stub.deleteEmail>>;
	try {
		result = await stub.deleteEmail(emailId);
	} catch (e) {
		await abortStorageDelete(env, owner, deletion);
		throw e;
	}
	if (result === null) {
		await abortStorageDelete(env, owner, deletion);
		return { status: "deleted", emailId };
	}
	if (result.length > 0) {
		try {
			await discardAttachmentObjects(env.BUCKET, emailId, result);
		} catch (e) {
			console.error("attachment cleanup failed:", (e as Error).message);
			await rememberOrphans(env, owner, attachmentObjectKeys(emailId, result), bytes, undefined, deletion).catch((err) => {
				console.error("orphan record failed:", (err as Error).message);
			});
			await abortStorageDelete(env, owner, deletion);
			return { error: "Attachment cleanup failed. Storage quota was kept.", emailId };
		}
	}
	await finishStorageDelete(env, owner, deletion);
	return { status: "deleted", emailId };
}

// ── send_reply ─────────────────────────────────────────────────────

export async function toolSendReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		bodyHtml: string;
	},
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const rateLimits = await sendRateLimits(env.FLAGS, flagContext(undefined, mailboxId));
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit(rateLimits);
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const originalEmail = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	if (!originalEmail) {
		return { error: "Original email not found" };
	}

	const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail);
	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	// Verify and append quoted original message
	const sanitizedBody = await verifyDraft(env.AI, params.bodyHtml);
	if (!sanitizedBody) {
		return { error: "Draft verification failed — refusing to send unverified content. Please try again." };
	}
	const quotedBlock = buildQuotedReplyBlock({
		date: originalEmail.date,
		sender: originalEmail.sender || params.to,
		body: originalEmail.body ?? undefined,
	});
	const fullBodyHtml = sanitizedBody + quotedBlock;
	const sentAt = new Date().toISOString();
	const referencesJson = references.length > 0 ? JSON.stringify(references) : null;
	const hold = await admitBody(env, mailboxId, fullBodyHtml, params.subject, {
		sender: mailboxId.toLowerCase(),
		recipient: params.to.toLowerCase(),
		date: sentAt,
		inReplyTo: originalMsgId,
		references: referencesJson,
		threadId,
		messageId: outgoingMessageId,
	});
	if (!hold.ok) return hold;

	try {
		await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: fullBodyHtml,
			headers: buildThreadingHeaders(originalMsgId, references),
		});
	} catch (e) {
		await hold.release();
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send reply: ${(e as Error).message}` };
	}

	try {
	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: sentAt,
			body: fullBodyHtml,
			in_reply_to: originalMsgId,
			email_references: referencesJson,
			thread_id: threadId,
			message_id: outgoingMessageId,
		},
		[],
	);
	} catch (e) {
		await hold.release();
		throw e;
	}

	await hold.commit();
	return { status: "sent", messageId, message: `Reply sent to ${params.to}` };
}

// ── send_email ─────────────────────────────────────────────────────

export async function toolSendEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		bodyHtml: string;
	},
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const rateLimits = await sendRateLimits(env.FLAGS, flagContext(undefined, mailboxId));
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit(rateLimits);
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const sanitizedBody = await verifyDraft(env.AI, params.bodyHtml);
	if (!sanitizedBody) {
		return { error: "Draft verification failed — refusing to send unverified content. Please try again." };
	}

	const sentAt = new Date().toISOString();
	const hold = await admitBody(env, mailboxId, sanitizedBody, params.subject, {
		sender: mailboxId.toLowerCase(),
		recipient: params.to.toLowerCase(),
		date: sentAt,
		messageId: outgoingMessageId,
	});
	if (!hold.ok) return hold;

	try {
		await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: sanitizedBody,
		});
	} catch (e) {
		await hold.release();
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send email: ${(e as Error).message}` };
	}

	try {
	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: sentAt,
			body: sanitizedBody,
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: outgoingMessageId,
		},
		[],
	);

	await hold.commit();
	return { status: "sent", messageId, message: `Email sent to ${params.to}` };
	} catch (e) {
		await hold.release();
		throw e;
	}
}
