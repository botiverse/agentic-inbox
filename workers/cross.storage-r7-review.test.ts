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


it('an unrelated open deletion cannot spend an untracked failed-cleanup gap',async()=>{
 await check(`
  await account.reserve(owner,'box@mail.build','box',10);
  await box.setUsage(100);
  const failed=await account.openStorageDelete(owner,20,'box@mail.build/old-mail');
  // Old row disappeared, but its R2 objects remain after cleanup failure.
  // Current HTTP DELETE aborts this operation and creates no orphan record.
  await box.setUsage(80);
  await account.abortStorageDelete(owner,failed.id);
  const before=await account.reserveStorage(owner,1,100);
  if(before.ok)throw new Error('setup must retain the failed cleanup charge');
  // Another request names 20 bytes in a completely different, still-existing row.
  const unrelated=await account.openStorageDelete(owner,20,'box@mail.build/other-mail');
  const next=await account.reserveStorage(owner,20,100);
  // Neither row nor objects from this second operation have been removed.
  if(next.ok){await box.setUsage(100);await account.commitStorage(owner,next.id);}
  await account.abortStorageDelete(owner,unrelated.id);
  return Response.json({allowed:next.ok,actualRows:await box.usageBytes(),retainedObjectBytes:20,counter:(await account.reserveStorage(owner,0,100)).used});
 `,v=>expect(v).toEqual({allowed:false,actualRows:80,retainedObjectBytes:20,counter:100}));
},30000);
