import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Login with Raft is the only identity. These strings are the API-key surface
// (Bearer mailbox tokens, the global admin key, mint/rotate/revoke). A reintroduction
// fails this test. Verified to go red: put `resolveKey` back in workers/app.ts.
describe("API key auth stays removed", () => {
	function walk(dir: string): string[] {
		const out: string[] = [];
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, ent.name);
			if (ent.isDirectory()) {
				if (ent.name === "node_modules" || ent.name === "build") continue;
				out.push(...walk(p));
			} else if (/\.(ts|tsx)$/.test(ent.name) && !ent.name.endsWith(".test.ts")) {
				out.push(p);
			}
		}
		return out;
	}

	const forbidden = [
		"resolveKey",
		"mintKey",
		"mintToken",
		"rotateKey",
		"revokeOwnerKey",
		"listOwnerKeys",
		"keyGuidance",
		"rotateMailboxKey",
		"key_guidance",
		"env.API_KEY",
		"/keys/rotate",
		"/mailboxes/${mailbox}/keys",
		"aibx_",
	];

	it("workers and app source do not mint, resolve, or advertise API keys", () => {
		const root = join(import.meta.dirname, "../..");
		const files = [...walk(join(root, "workers")), ...walk(join(root, "app"))];
		const hits: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			for (const needle of forbidden) {
				if (text.includes(needle)) hits.push(`${file}: ${needle}`);
			}
		}
		expect(hits, hits.join("\n")).toEqual([]);
	});
});
