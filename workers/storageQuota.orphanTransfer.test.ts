import { expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { resolve } from "node:path";

async function check(body: string, verify: (value: any) => void) {
	const bundle = await build({
		stdin: {
			contents: `
  import {DurableObject} from 'cloudflare:workers';
  import {OwnerDO as ActualOwner} from './workers/ownerDO';
  export class OwnerDO extends ActualOwner {constructor(ctx,env){super(ctx,{...env,BUCKET:{delete:async()=>{}}});}}
  export class UsageMailbox extends DurableObject {bytes=0;async setUsage(n){this.bytes=n;}async usageBytes(){return this.bytes;}}
  export default {async fetch(request,env){const owner='account';const account=env.OWNER.get(env.OWNER.idFromName(owner));const box=env.MAILBOX.get(env.MAILBOX.idFromName('box@mail.build'));${body}}};
 `,
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
		name: "orphan-transfer",
		modules: true,
		script: bundle.outputFiles[0].text,
		compatibilityDate: "2025-11-28",
		durableObjects: {
			OWNER: { className: "OwnerDO", useSQLite: true },
			MAILBOX: { className: "UsageMailbox", useSQLite: true },
		},
	}));
	try {
		verify(await (await mf.dispatchFetch("https://test/")).json());
	} finally {
		await mf.dispose();
	}
}

it("a repeated orphan transfer and a later delete completion refund once", async () => {
	await check(`
  await account.reserve(owner,'box@mail.build','box',10);
  await box.setUsage(100);
  await account.reserveStorage(owner,0,100);
  const op=await account.openStorageDelete(owner,20,'box@mail.build/old-mail');
  await box.setUsage(80);
  await account.retainOrphans(['attachments/old/a.bin'],20,undefined,op.id);
  await account.retainOrphans(['attachments/old/a.bin'],20,undefined,op.id);
  await account.abortStorageDelete(owner,op.id);
  await account.retainOrphans(['attachments/old/a.bin'],20,undefined,op.id);
  await account.completeStorageDelete(owner,op.id);
  await account.completeStorageDelete(owner,op.id);
  const next=await account.reserveStorage(owner,21,100);
  return Response.json({counter:(await account.reserveStorage(owner,0,100)).used,actual:await box.usageBytes(),nextAllowed:next.ok});
 `, (v) => expect(v).toEqual({ counter: 80, actual: 80, nextAllowed: false }));
}, 30000);

it("an orphan registration after the delete already settled does not refund again", async () => {
	await check(`
  await account.reserve(owner,'box@mail.build','box',10);
  await box.setUsage(100);
  await account.reserveStorage(owner,0,100);
  const op=await account.openStorageDelete(owner,20,'box@mail.build/old-mail');
  await box.setUsage(80);
  await account.completeStorageDelete(owner,op.id);
  await account.retainOrphans(['attachments/old/a.bin'],20,undefined,op.id);
  const next=await account.reserveStorage(owner,21,100);
  return Response.json({counter:(await account.reserveStorage(owner,0,100)).used,actual:await box.usageBytes(),nextAllowed:next.ok});
 `, (v) => expect(v).toEqual({ counter: 80, actual: 80, nextAllowed: false }));
}, 30000);
