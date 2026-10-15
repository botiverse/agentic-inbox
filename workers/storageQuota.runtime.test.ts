import { expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it("real OwnerDO caps concurrent storage reservations and keeps the counter across restart", async () => {
	const bundled = await build({
		stdin: {
			contents: `
				export { OwnerDO } from "./workers/ownerDO";
				export default { async fetch(request, env) {
					const url = new URL(request.url);
					const owner = url.pathname.slice(1);
					const bytes = Number(url.searchParams.get("bytes") ?? "0");
					const limit = Number(url.searchParams.get("limit") ?? "10");
					const stub = env.OWNER.get(env.OWNER.idFromName(owner));
					if (url.searchParams.get("release") === "1") return Response.json(await stub.releaseStorage(owner, bytes));
					return Response.json(await stub.reserveStorage(owner, bytes, limit));
				}};`,
			resolveDir: resolve("."),
			sourcefile: "storage-runtime-entry.ts",
			loader: "ts",
		},
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		external: ["cloudflare:workers"],
	});
	const path = await mkdtemp(join(tmpdir(), "mail-storage-test-"));
	const options = convertV4MiniflareOptions({
		name: "storage-runtime",
		modules: true as const,
		script: bundled.outputFiles[0].text,
		compatibilityDate: "2025-11-28",
		compatibilityFlags: ["nodejs_compat"],
		durableObjects: { OWNER: { className: "OwnerDO", useSQLite: true } },
		durableObjectsPersist: path,
	});
	options.resourcePersistencePath = path;
	let runtime = new Miniflare(options);
	try {
		const results = await Promise.all(Array.from({ length: 20 }, async () =>
			(await runtime.dispatchFetch("https://test/account-one?bytes=1&limit=10")).json() as Promise<{ ok: boolean; used: number }>));
		expect(results.filter((row) => row.ok)).toHaveLength(10);
		expect(results.every((row) => row.used <= 10)).toBe(true);
		expect(await (await runtime.dispatchFetch("https://test/account-two?bytes=10&limit=10")).json()).toMatchObject({ ok: true, used: 10 });
		await runtime.dispose();
		runtime = new Miniflare(options);
		expect(await (await runtime.dispatchFetch("https://test/account-one?bytes=1&limit=10")).json()).toMatchObject({ ok: false, used: 10 });
		expect(await (await runtime.dispatchFetch("https://test/account-one?bytes=4&release=1")).json()).toMatchObject({ used: 6 });
		expect(await (await runtime.dispatchFetch("https://test/account-one?bytes=4&limit=10")).json()).toMatchObject({ ok: true, used: 10 });
	} finally {
		await runtime.dispose();
		await rm(path, { recursive: true, force: true });
	}
}, 30_000);
