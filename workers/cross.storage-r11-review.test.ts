import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { resolve } from 'node:path';

async function check(body:string,verify:(value:any)=>void){
 const bundle=await build({stdin:{contents:`
  import {DurableObject} from 'cloudflare:workers';
  import {OwnerDO as ActualOwner} from './workers/ownerDO'; export class OwnerDO extends ActualOwner {constructor(ctx,env){super(ctx,{...env,BUCKET:{delete:async()=>{}}});}}
  export class UsageMailbox extends DurableObject {bytes=0;async setUsage(n){this.bytes=n;}async usageBytes(){return this.bytes;}}
  export default {async fetch(request,env){const owner='account';const account=env.OWNER.get(env.OWNER.idFromName(owner));const box=env.MAILBOX.get(env.MAILBOX.idFromName('box@mail.build'));${body}}};
 `,resolveDir:resolve('.'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const mf=new Miniflare(convertV4MiniflareOptions({name:'r4-review',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-11-28',durableObjects:{OWNER:{className:'OwnerDO',useSQLite:true},MAILBOX:{className:'UsageMailbox',useSQLite:true}}}));
 try{verify(await(await mf.dispatchFetch('https://test/')).json());}finally{await mf.dispose();}
}


it('transferring a row delete to an orphan also retires its original create hold',async()=>{
 await check(`
  await account.reserve(owner,'box@mail.build','box',10);
  await box.setUsage(80);
  const row='box@mail.build/new-mail';
  const hold=await account.reserveStorage(owner,20,100,undefined,row);
  if(!hold.ok)throw new Error('setup');
  await box.setUsage(100);
  // Another request deletes this row before the creator receives its result.
  const deletion=await account.openStorageDelete(owner,20,row);
  await box.setUsage(80);
  // Its first R2 cleanup failed; the deletion transfers its refund to an orphan.
  await account.retainOrphans(['attachments/new-mail/a.bin'],20,undefined,deletion.id);
  await account.abortStorageDelete(owner,deletion.id);
  // The create response was lost; re-read finds null, so the caller cancels.
  // R2 recovers by this call, whose sweep must be the sole refund.
  await account.cancelStorage(owner,hold.id);
  const state=await account.reserveStorage(owner,0,100);
  const next=await account.reserveStorage(owner,21,100);
  return Response.json({counter:state.used,actual:await box.usageBytes(),nextAllowed:next.ok});
 `,v=>expect(v).toEqual({counter:80,actual:80,nextAllowed:false}));
},30000);
