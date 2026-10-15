import { expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { resolve } from "node:path";

it("a draft replacement spends only its own prepared row, and other writes do not", async () => {
	const bundle = await build({
		stdin: {
			contents: `
				import { DurableObject } from "cloudflare:workers";
				export { OwnerDO } from "./workers/ownerDO";
				export class UsageMailbox extends DurableObject {
					bytes = 0;
					async setUsage(n) { this.bytes = n; }
					async usageBytes() { return this.bytes; }
				}
				export default { async fetch(request, env) {
					const owner = "account";
					const account = env.OWNER.get(env.OWNER.idFromName(owner));
					const box = env.MAILBOX.get(env.MAILBOX.idFromName("box@mail.build"));
					await account.reserve(owner, "box@mail.build", "box", 10);
					await box.setUsage(100);
					const replacement = await account.openStorageDelete(owner, 40, "box@mail.build/draft");
					const outsider = await account.reserveStorage(owner, 10, 100);
					const held = await account.reserveStorage(owner, 30, 100, replacement.id);
					const again = await account.openStorageDelete(owner, 40, "box@mail.build/draft");
					const second = await account.reserveStorage(owner, 30, 100, again.id);
					if (held.ok) await account.commitStorage(owner, held.id);
					await account.completeStorageDelete(owner, replacement.id);
					await account.abortStorageDelete(owner, again.id);
					await box.setUsage(90);
					const after = await account.reserveStorage(owner, 0, 100);
					return Response.json({
						outsider: outsider.ok,
						held: held.ok,
						second: second.ok,
						counter: after.used,
						actual: await box.usageBytes(),
					});
				}};`,
			resolveDir: resolve("."),
			loader: "ts",
		},
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		external: ["cloudflare:workers"],
	});
	const mf = new Miniflare(convertV4MiniflareOptions({
		name: "exclusive-replace",
		modules: true,
		script: bundle.outputFiles[0].text,
		compatibilityDate: "2025-11-28",
		durableObjects: {
			OWNER: { className: "OwnerDO", useSQLite: true },
			MAILBOX: { className: "UsageMailbox", useSQLite: true },
		},
	}));
	try {
		const value = await (await mf.dispatchFetch("https://test/")).json();
		expect(value).toEqual({ outsider: false, held: true, second: false, counter: 90, actual: 90 });
	} finally {
		await mf.dispose();
	}
}, 30_000);
