/** Account storage quota. Bytes are what we persist: UTF-8 body, subject, and attachment sizes. */

export const STORAGE_QUOTA_FREE_BYTES = 10 * 1024 * 1024 * 1024;
export const STORAGE_QUOTA_PRO_BYTES = 20 * 1024 * 1024 * 1024;

const USED_KEY = "storage:used";

export function storageLimitBytes(plan: string | null | undefined): number {
	return plan === "pro" ? STORAGE_QUOTA_PRO_BYTES : STORAGE_QUOTA_FREE_BYTES;
}

export function bodyBytes(body: string | null | undefined): number {
	return new TextEncoder().encode(body ?? "").byteLength;
}

/** Bytes a message will add. Subject is stored beside the body and is not free. */
export function storedMailBytes(
	body: string | null | undefined,
	attachmentBytes = 0,
	subject = "",
): number {
	return bodyBytes(body) + bodyBytes(subject) + Math.max(0, attachmentBytes);
}

type StorageTx = {
	get(key: string): Promise<unknown>;
	put(key: string, value: unknown): Promise<void>;
};

export type StorageAdmission = { ok: boolean; used: number; limit: number };

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
