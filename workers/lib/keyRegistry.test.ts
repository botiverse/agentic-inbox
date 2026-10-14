import { describe, it, expect } from "vitest";
import { recordOwnedMailbox, removeOwnedMailbox, listOwnedMailboxes, countOwnedMailboxes } from "./keyRegistry";

// Minimal in-memory KVNamespace (get json / put+metadata / delete / prefix list).
function mockKV(): KVNamespace {
	const store = new Map<string, { value: string; metadata?: unknown }>();
	return {
		async get(key: string, type?: unknown) {
			const e = store.get(key);
			if (!e) return null;
			return type === "json" ? JSON.parse(e.value) : e.value;
		},
		async put(key: string, value: string, options?: { metadata?: unknown }) {
			store.set(key, { value, metadata: options?.metadata });
		},
		async delete(key: string) {
			store.delete(key);
		},
		async list(options?: { prefix?: string }) {
			const prefix = options?.prefix ?? "";
			const keys = [...store.keys()]
				.filter((k) => k.startsWith(prefix))
				.map((name) => ({ name, metadata: store.get(name)!.metadata }));
			return { keys, list_complete: true, cursor: undefined };
		},
	} as unknown as KVNamespace;
}

const envWith = () => ({ AGENTIC_INBOX_KEYS: mockKV() });

describe("keyRegistry: owned mailbox index", () => {
	it("records, lists, counts, and removes an owner's mailboxes", async () => {
		const env = envWith();
		await recordOwnedMailbox(env, "o1", "a@x", "A");
		await recordOwnedMailbox(env, "o1", "b@x");
		await recordOwnedMailbox(env, "o2", "c@x", "C");
		expect(await countOwnedMailboxes(env, "o1")).toBe(2);
		expect(await listOwnedMailboxes(env, "o1")).toEqual([
			{ email: "a@x", name: "A" },
			{ email: "b@x", name: "b@x" },
		]);
		await removeOwnedMailbox(env, "o1", "a@x");
		expect(await countOwnedMailboxes(env, "o1")).toBe(1);
		expect(await listOwnedMailboxes(env, "o1")).toEqual([{ email: "b@x", name: "b@x" }]);
		expect(await listOwnedMailboxes(env, "o2")).toEqual([{ email: "c@x", name: "C" }]);
	});

	it("does nothing when the KV binding is absent", async () => {
		const env = {};
		await recordOwnedMailbox(env, "o1", "a@x", "A");
		await removeOwnedMailbox(env, "o1", "a@x");
		expect(await countOwnedMailboxes(env, "o1")).toBe(0);
		expect(await listOwnedMailboxes(env, "o1")).toEqual([]);
	});
});
