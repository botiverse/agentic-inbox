import { expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it("real OwnerDO serializes concurrent mailbox sends and retains quota after restart", async () => {
  const bundled = await build({
    stdin: { contents: `
      export { OwnerDO } from "./workers/ownerDO";
      export default { async fetch(request, env) {
        const owner = new URL(request.url).pathname.slice(1);
        const stub = env.OWNER.get(env.OWNER.idFromName(owner));
        return Response.json(await stub.reserveSend());
      }};`, resolveDir: resolve("."), sourcefile: "quota-runtime-entry.ts", loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"],
  });
  const path = await mkdtemp(join(tmpdir(), "mail-quota-test-"));
  const options = convertV4MiniflareOptions({ name: "quota-runtime", modules: true as const, script: bundled.outputFiles[0].text,
    compatibilityDate: "2025-11-28", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { OWNER: { className: "OwnerDO", useSQLite: true } }, durableObjectsPersist: path });
  options.resourcePersistencePath = path;
  let runtime = new Miniflare(options);
  try {
    const results = await Promise.all(Array.from({ length: 20 }, async () =>
      (await runtime.dispatchFetch("https://test/account-one")).json() as Promise<{ ok: boolean; retryAt: number }>));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const retryAt = results[0].retryAt;
    expect(results.every(r => r.retryAt === retryAt)).toBe(true);
    expect(await (await runtime.dispatchFetch("https://test/account-two")).json()).toMatchObject({ ok: true });
    await runtime.dispose();
    runtime = new Miniflare(options);
    expect(await (await runtime.dispatchFetch("https://test/account-one")).json()).toEqual({ ok: false, retryAt });
  } finally {
    await runtime.dispose();
    await rm(path, { recursive: true, force: true });
  }
}, 30_000);
