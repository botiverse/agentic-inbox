import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { resolve } from 'node:path';

async function check(body:string,verify:(value:any)=>void){
 const bundle=await build({stdin:{contents:`
  import {DurableObject} from 'cloudflare:workers';
  export {OwnerDO} from './workers/ownerDO';
  export class UsageMailbox extends DurableObject {bytes=0;async setUsage(n){this.bytes=n;}async usageBytes(){return this.bytes;}}
  export default {async fetch(request,env){const owner='account';const account=env.OWNER.get(env.OWNER.idFromName(owner));const box=env.MAILBOX.get(env.MAILBOX.idFromName('box@mail.build'));${body}}};
 `,resolveDir:resolve('.'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const mf=new Miniflare(convertV4MiniflareOptions({name:'r4-review',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-11-28',durableObjects:{OWNER:{className:'OwnerDO',useSQLite:true},MAILBOX:{className:'UsageMailbox',useSQLite:true}}}));
 try{verify(await(await mf.dispatchFetch('https://test/')).json());}finally{await mf.dispose();}
}

it('a delayed deletion refund cannot take bytes reserved by a different in-flight write',async()=>{
 await check(`
  await account.reserve(owner,'box@mail.build','box',10);
  await box.setUsage(100);
  // Name this deletion before the row disappears. Its refund stays delayed.
  const deletion=await account.openStorageDelete(owner,20);
  await box.setUsage(80);
  // Settlement is not confirmed yet, so this reservation waits.
  const early=await account.reserveStorage(owner,20,100);
  if(early.ok)throw new Error('reservation must wait until the delete settles');
  await account.completeStorageDelete(owner,deletion.id);
  const pending=await account.reserveStorage(owner,20,100);
  if(!pending.ok)throw new Error('settled delete should free its own bytes');
  const beforeCommit=(await account.reserveStorage(owner,0,100)).used;
  // The admitted write now completes; it must still have its 20-byte reservation.
  await box.setUsage(100);
  const next=await account.reserveStorage(owner,1,100);
  return Response.json({counterBeforeCommit:beforeCommit,actualAfterCommit:await box.usageBytes(),nextAllowed:next.ok});
 `,v=>expect(v).toEqual({counterBeforeCommit:100,actualAfterCommit:100,nextAllowed:false}));
},30000);

it('releasing a pre-existing mailbox before first quota use cannot erase retained-byte attribution',async()=>{
 await check(`
  await account.reserve(owner,'box@mail.build','box',10);
  await box.setUsage(100);
  // The first operation after the rollout is deleting/releasing this mailbox slot.
  await account.release(owner,'box@mail.build');
  await account.reserve(owner,'newbox@mail.build','new',10);
  const next=await account.reserveStorage(owner,1,100);
  return Response.json({retained:await box.usageBytes(),counter:next.used,nextAllowed:next.ok});
 `,v=>expect(v).toEqual({retained:100,counter:100,nextAllowed:false}));
},30000);
