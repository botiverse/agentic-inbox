import { describe, it, expect } from "vitest";
import {
	mintKey,
	resolveKey,
	rotateKey,
	listOwnerKeys,
	revokeOwnerKey,
	keyGuidance,
} from "./keyRegistry";

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

describe("keyRegistry: mint / resolve", () => {
	it("mints a key that resolves to its owner+scope", async () => {
		const env = envWith();
		await mintKey(env, { owner: "o1", scope: "a@x", token: "aibx_1", now: "t0" });
		expect(await resolveKey(env, "aibx_1")).toEqual({ owner: "o1", scope: "a@x" });
	});
});

describe("keyRegistry: rotate (Gogo's key-security bar)", () => {
	it("new key valid, old revoked, exactly one active at that scope", async () => {
		const env = envWith();
		await mintKey(env, { owner: "o1", scope: "a@x", token: "aibx_old", now: "t0" });
		const { token, revoked } = await rotateKey(env, { owner: "o1", scope: "a@x", token: "aibx_new", now: "t1" });
		expect(token).toBe("aibx_new");
		expect(revoked).toBe(1);
		expect(await resolveKey(env, "aibx_new")).toEqual({ owner: "o1", scope: "a@x" }); // new works
		expect(await resolveKey(env, "aibx_old")).toBeNull(); // old immediately dead
		const active = (await listOwnerKeys(env, "o1", "a@x")).filter((k) => !k.disabled);
		expect(active.length).toBe(1);
	});
	it("rotate only touches the target scope (never other mailboxes)", async () => {
		const env = envWith();
		await mintKey(env, { owner: "o1", scope: "a@x", token: "aibx_a", now: "t0" });
		await mintKey(env, { owner: "o1", scope: "b@x", token: "aibx_b", now: "t0" });
		await rotateKey(env, { owner: "o1", scope: "a@x", token: "aibx_a2", now: "t1" });
		expect(await resolveKey(env, "aibx_b")).toEqual({ owner: "o1", scope: "b@x" }); // untouched
	});
});

describe("keyRegistry: list / revoke (no plaintext, owner-scoped)", () => {
	it("listOwnerKeys returns metadata only — never the raw token", async () => {
		const env = envWith();
		await mintKey(env, { owner: "o1", scope: "a@x", token: "aibx_secret", label: "L", now: "t0" });
		const keys = await listOwnerKeys(env, "o1");
		expect(keys).toHaveLength(1);
		expect(JSON.stringify(keys)).not.toContain("aibx_secret");
		expect(keys[0]).toMatchObject({ scope: "a@x", label: "L", disabled: false });
	});
	it("revokeOwnerKey only revokes the owner's own key (A cannot revoke B's)", async () => {
		const env = envWith();
		const { hash } = await mintKey(env, { owner: "ownerB", scope: "b@x", token: "aibx_b", now: "t0" });
		expect(await revokeOwnerKey(env, "ownerA", hash)).toBe(false); // cross-principal denied
		expect(await resolveKey(env, "aibx_b")).not.toBeNull(); // still live
		expect(await revokeOwnerKey(env, "ownerB", hash)).toBe(true); // owner allowed
		expect(await resolveKey(env, "aibx_b")).toBeNull(); // now dead
	});
});

describe("keyRegistry: keyGuidance", () => {
	it("is structured, scoped to the mailbox, and points at rotate/revoke", () => {
		const g = keyGuidance("me@mail.build");
		expect(g.scope).toContain("me@mail.build");
		expect(g.how_to_use).toContain("Bearer");
		expect(g.rotate).toContain("/keys/rotate");
		expect(g.revoke).toContain("/keys/");
		expect(g.not_needed_for).toContain("raft");
	});
});
