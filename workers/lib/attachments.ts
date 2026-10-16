// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared attachment storage logic.
 * Eliminates the triplicated atob → Uint8Array → R2.put pattern.
 */
import type { Env } from "../types";

export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
}

/** The reservation must stay if these objects could not be removed. */
export class AttachmentCleanupError extends Error {
	readonly keys: string[];
	readonly bytes: number;
	constructor(message: string, keys: string[] = [], bytes = 0) {
		super(message);
		this.name = "AttachmentCleanupError";
		this.keys = keys;
		this.bytes = bytes;
	}
}

export function attachmentObjectKeys(emailId: string, stored: Array<{ id: string; filename: string }>): string[] {
	return stored.map((att) => `attachments/${emailId}/${att.id}/${att.filename}`);
}

export async function discardAttachmentObjects(
	bucket: Env["BUCKET"],
	emailId: string,
	stored: Array<{ id: string; filename: string }>,
): Promise<void> {
	const keys = attachmentObjectKeys(emailId, stored);
	if (keys.length === 0) return;
	await bucket.delete(keys);
}

/**
 * Store base64-encoded attachments to R2 and return metadata for the DO.
 */
export async function storeAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	attachments?: {
		content: string;
		filename: string;
		type: string;
		disposition: string;
		contentId?: string;
	}[],
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return [];

	const attempted: StoredAttachment[] = [];
	try {
		for (const att of attachments) {
			const attachmentId = crypto.randomUUID();
			// Sanitize filename to prevent path traversal in R2 keys
			const safeFilename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			const key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;
			const binaryStr = atob(att.content);
			const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
			// Record the key before put. A committed object whose response is lost
			// is still in `attempted`, so cleanup can delete it.
			const stored: StoredAttachment = {
				id: attachmentId,
				email_id: emailId,
				filename: safeFilename,
				mimetype: att.type,
				size: bytes.byteLength,
				content_id: att.contentId || null,
				disposition: att.disposition,
			};
			attempted.push(stored);
			await bucket.put(key, bytes);
		}
		return attempted;
	} catch (e) {
		const keys = attachmentObjectKeys(emailId, attempted);
		const charged = attempted.reduce((sum, att) => sum + att.size, 0);
		try {
			await discardAttachmentObjects(bucket, emailId, attempted);
		} catch (cleanupErr) {
			throw new AttachmentCleanupError((cleanupErr as Error).message, keys, charged);
		}
		throw e;
	}
}
