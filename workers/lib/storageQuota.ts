/** Account storage quota. Caller-supplied strings are billed at any length.
 * A thread id that only repeats the row id is not a second copy of caller data.
 * Dates, message ids, and ordinary sender addresses are billed once they exceed
 * the fixed size of the value this process generates. */

export const STORAGE_QUOTA_FREE_BYTES = 2 * 1024 * 1024 * 1024;
export const STORAGE_QUOTA_PRO_BYTES = 20 * 1024 * 1024 * 1024;

/** `uuid@domain` message ids fit under this. Longer ones are caller content. */
export const UNBILLED_MESSAGE_ID_BYTES = 64;
/** Normal mailbox addresses fit under this. A longer sender is stored in full. */
export const UNBILLED_SENDER_BYTES = 320;
/** ISO timestamps fit under this. */
export const UNBILLED_DATE_BYTES = 40;

const USED_KEY = "storage:used";

export function storageLimitBytes(plan: string | null | undefined): number {
	return plan === "pro" ? STORAGE_QUOTA_PRO_BYTES : STORAGE_QUOTA_FREE_BYTES;
}

export function bodyBytes(body: string | null | undefined): number {
	return new TextEncoder().encode(body ?? "").byteLength;
}

/** Full byte length when `value` is longer than `allowance`; otherwise 0. */
export function meteredBytes(value: string | null | undefined, allowance = 0): number {
	const n = bodyBytes(value);
	return n > allowance ? n : 0;
}

function excessSql(column: string, allowance: number): string {
	const length = `COALESCE(LENGTH(CAST(${column} AS BLOB)), 0)`;
	if (allowance <= 0) return length;
	return `CASE WHEN ${length} > ${allowance} THEN ${length} ELSE 0 END`;
}

/** SQL expression matching `storedMailBytes` for one emails row. No leading SUM. */
export const EMAIL_ROW_BYTES_SQL = [
	excessSql("body", 0),
	excessSql("subject", 0),
	excessSql("recipient", 0),
	excessSql("cc", 0),
	excessSql("bcc", 0),
	excessSql("in_reply_to", 0),
	excessSql("email_references", 0),
	excessSql("raw_headers", 0),
	// A thread id equal to the row id only repeats the primary key. Any other
	// value, including a caller-supplied UUID, is stored caller data and is billed in full.
	"CASE WHEN thread_id IS NULL OR thread_id = id THEN 0 ELSE COALESCE(LENGTH(CAST(thread_id AS BLOB)), 0) END",
	excessSql("message_id", UNBILLED_MESSAGE_ID_BYTES),
	excessSql("sender", UNBILLED_SENDER_BYTES),
	excessSql("date", UNBILLED_DATE_BYTES),
].join(" + ");

/** SQL expression for one attachments row: content size plus its stored names. */
export const ATTACHMENT_ROW_BYTES_SQL = [
	"COALESCE(size, 0)",
	excessSql("filename", 0),
	excessSql("mimetype", 0),
	excessSql("content_id", 0),
	excessSql("disposition", 0),
].join(" + ");

export type StoredMailFields = {
	sender?: string | null;
	recipient?: string | null;
	cc?: string | null;
	bcc?: string | null;
	date?: string | null;
	inReplyTo?: string | null;
	references?: string | null;
	threadId?: string | null;
	messageId?: string | null;
	rawHeaders?: string | null;
};

/** Bytes a message will add. Empty optional fields add nothing. */
export function storedMailBytes(
	body: string | null | undefined,
	attachmentBytes = 0,
	subject = "",
	fields: StoredMailFields = {},
): number {
	return (
		meteredBytes(body) +
		meteredBytes(subject) +
		meteredBytes(fields.sender, UNBILLED_SENDER_BYTES) +
		meteredBytes(fields.recipient) +
		meteredBytes(fields.cc) +
		meteredBytes(fields.bcc) +
		meteredBytes(fields.date, UNBILLED_DATE_BYTES) +
		meteredBytes(fields.inReplyTo) +
		meteredBytes(fields.references) +
		meteredBytes(fields.threadId) +
		meteredBytes(fields.messageId, UNBILLED_MESSAGE_ID_BYTES) +
		meteredBytes(fields.rawHeaders) +
		Math.max(0, attachmentBytes)
	);
}

/** Content size plus the text columns stored beside an attachment. */
export function attachmentRecordBytes(att: {
	size: number;
	filename?: string | null;
	mimetype?: string | null;
	contentId?: string | null;
	content_id?: string | null;
	disposition?: string | null;
}): number {
	return (
		Math.max(0, att.size) +
		meteredBytes(att.filename) +
		meteredBytes(att.mimetype) +
		meteredBytes(att.contentId ?? att.content_id) +
		meteredBytes(att.disposition)
	);
}

/** Bytes of one persisted email row, including every variable-sized column. */
export function storedRowBytes(
	row: {
		id?: string | null;
		body?: string | null;
		subject?: string | null;
		sender?: string | null;
		recipient?: string | null;
		cc?: string | null;
		bcc?: string | null;
		date?: string | null;
		in_reply_to?: string | null;
		email_references?: string | null;
		thread_id?: string | null;
		message_id?: string | null;
		raw_headers?: string | null;
	},
	attachmentBytes = 0,
): number {
	const threadId = row.thread_id && row.thread_id !== row.id ? row.thread_id : null;
	return storedMailBytes(row.body, attachmentBytes, row.subject ?? "", {
		sender: row.sender,
		recipient: row.recipient,
		cc: row.cc,
		bcc: row.bcc,
		date: row.date,
		inReplyTo: row.in_reply_to,
		references: row.email_references,
		threadId,
		messageId: row.message_id,
		rawHeaders: row.raw_headers,
	});
}

type StorageTx = {
	get(key: string): Promise<unknown>;
	put(key: string, value: unknown): Promise<void>;
};

export type StorageAdmission = { ok: boolean; used: number; limit: number; id?: string };

/**
 * Add `bytes` only when the result stays within `limit`. The caller seeds
 * `storage:used` before the first call. A failed admission does not change it.
 */
export async function reserveStoredBytes(
	storage: { transaction<T>(run: (tx: StorageTx) => Promise<T>): Promise<T> },
	bytes: number,
	limit: number,
): Promise<StorageAdmission> {
	const add = Math.max(0, Math.floor(bytes));
	return storage.transaction(async (tx) => {
		const used = Number((await tx.get(USED_KEY)) ?? 0);
		if (add > 0 && used + add > limit) return { ok: false, used, limit };
		const next = used + add;
		if (next !== used) await tx.put(USED_KEY, next);
		return { ok: true, used: next, limit };
	});
}

/** Give bytes back. Never goes below zero. */
export async function releaseStoredBytes(
	storage: { transaction<T>(run: (tx: StorageTx) => Promise<T>): Promise<T> },
	bytes: number,
): Promise<{ used: number }> {
	const sub = Math.max(0, Math.floor(bytes));
	return storage.transaction(async (tx) => {
		const used = Number((await tx.get(USED_KEY)) ?? 0);
		const next = Math.max(0, used - sub);
		if (next !== used) await tx.put(USED_KEY, next);
		return { used: next };
	});
}
