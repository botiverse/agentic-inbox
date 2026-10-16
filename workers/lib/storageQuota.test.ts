import { describe, expect, it } from "vitest";
import { releaseStoredBytes, reserveStoredBytes, STORAGE_QUOTA_FREE_BYTES, STORAGE_QUOTA_PRO_BYTES, storageLimitBytes, storedMailBytes, storedRowBytes } from "./storageQuota";

function durableStorage(initial = 0) {
	const values = new Map<string, unknown>([["storage:used", initial]]);
	let tail = Promise.resolve();
	return {
		transaction<T>(callback: (tx: { get: (key: string) => Promise<unknown>; put: (key: string, value: unknown) => Promise<void> }) => Promise<T>): Promise<T> {
			const run = tail.then(() => callback({
				get: async (key: string) => {
					await Promise.resolve();
					return values.get(key);
				},
				put: async (key: string, value: unknown) => {
					values.set(key, value);
				},
			}));
			tail = run.then(() => undefined, () => undefined);
			return run;
		},
	};
}

describe("stored mail bytes", () => {
	it("counts UTF-8 body bytes and attachment sizes", () => {
		expect(storedMailBytes("hi", 3)).toBe(5);
		expect(storedMailBytes("你", 0)).toBe(3);
		expect(storedMailBytes("", 0, "x".repeat(1000))).toBe(1000);
		expect(storedMailBytes("", 0, "", { recipient: "x".repeat(1000) })).toBe(1000);
		expect(storedMailBytes("body", 0, "", { sender: "box@mail.build", threadId: "x".repeat(36) })).toBe(40);
		expect(storedRowBytes({ id: "same", body: "body", thread_id: "same" })).toBe(4);
		expect(storedRowBytes({ id: "row", body: "", thread_id: "x".repeat(36) })).toBe(36);
		expect(STORAGE_QUOTA_FREE_BYTES).toBe(2 * 1024 * 1024 * 1024);
		expect(STORAGE_QUOTA_PRO_BYTES).toBe(20 * 1024 * 1024 * 1024);
		expect(storageLimitBytes("pro")).toBe(STORAGE_QUOTA_PRO_BYTES);
		expect(storageLimitBytes("free")).toBe(STORAGE_QUOTA_FREE_BYTES);
		expect(storageLimitBytes(undefined)).toBe(STORAGE_QUOTA_FREE_BYTES);
	});
});

describe("account storage admission", () => {
	it("admits concurrent writes only up to the cap and keeps the rejected ones off the counter", async () => {
		const storage = durableStorage(0);
		const attempts = await Promise.all(Array.from({ length: 20 }, () => reserveStoredBytes(storage, 1, 10)));
		expect(attempts.filter((row) => row.ok)).toHaveLength(10);
		expect(attempts.filter((row) => !row.ok).every((row) => row.used <= 10)).toBe(true);
		expect(await reserveStoredBytes(storage, 1, 10)).toMatchObject({ ok: false, used: 10 });
	});

	it("reclaims deleted bytes and then admits another write", async () => {
		const storage = durableStorage(0);
		expect((await reserveStoredBytes(storage, 8, 10)).ok).toBe(true);
		expect((await releaseStoredBytes(storage, 3)).used).toBe(5);
		expect(await reserveStoredBytes(storage, 5, 10)).toMatchObject({ ok: true, used: 10 });
		expect((await reserveStoredBytes(storage, 1, 10)).ok).toBe(false);
	});

	it("keeps accounts separate", async () => {
		const one = durableStorage(0);
		const two = durableStorage(0);
		expect((await reserveStoredBytes(one, 10, 10)).ok).toBe(true);
		expect((await reserveStoredBytes(two, 10, 10)).ok).toBe(true);
		expect((await reserveStoredBytes(one, 1, 10)).ok).toBe(false);
	});

	it("does not admit a write when storage fails", async () => {
		const storage = { transaction: async () => { throw new Error("unavailable"); } };
		await expect(reserveStoredBytes(storage, 1, 10)).rejects.toThrow("unavailable");
	});
});
