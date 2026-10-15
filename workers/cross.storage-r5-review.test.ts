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


it('a failed deletion cannot lend space to a different committed write',async()=>{
 await check(`
  await account.reserve(owner,'box@mail.build','box',10);
  await box.setUsage(100);
  const deletion=await account.openStorageDelete(owner,20);
  const pending=await account.reserveStorage(owner,20,100);
  if(pending.ok){await box.setUsage(120);await account.commitStorage(owner,pending.id);}
  await account.abortStorageDelete(owner,deletion.id);
  return Response.json({admitted:pending.ok,actual:await box.usageBytes(),counter:(await account.reserveStorage(owner,0,100)).used});
 `,v=>expect(v).toEqual({admitted:false,actual:100,counter:100}));
},30000);

it('two intents for one deletion cannot lend the same stored bytes twice',async()=>{
 await check(`
  await account.reserve(owner,'box@mail.build','box',10);
  await box.setUsage(100);
  const first=await account.openStorageDelete(owner,20);
  const second=await account.openStorageDelete(owner,20);
  await box.setUsage(80);
  await account.completeStorageDelete(owner,first.id);
  const pending=await account.reserveStorage(owner,40,100);
  if(pending.ok){await box.setUsage(120);await account.commitStorage(owner,pending.id);}
  await account.abortStorageDelete(owner,second.id);
  return Response.json({admitted:pending.ok,actual:await box.usageBytes(),counter:(await account.reserveStorage(owner,0,100)).used});
 `,v=>expect(v).toEqual({admitted:false,actual:80,counter:80}));
},30000);

import { app } from './index';
it('a delete RPC failure must settle its open deletion operation',async()=>{
 const open=new Map<string,number>();
 const env={
  BUCKET:{get:async()=>({json:async()=>({owner:'account'})})},
  OWNER:{idFromName:(s:string)=>s,get:()=>({
   openStorageDelete:async(_o:string,bytes:number)=>{open.set('operation',bytes);return{id:'operation',used:80};},
   abortStorageDelete:async(_o:string,id:string)=>{open.delete(id);return{used:100};},
   completeStorageDelete:async(_o:string,id:string)=>{open.delete(id);return{used:80};},
  })},
  MAILBOX:{idFromName:(s:string)=>s,get:()=>({
   measureEmailBytes:async()=>20,
   deleteEmail:async()=>{throw new Error('injected delete failure before mutation');},
  })},
 };
 const res=await app.request('/api/v1/mailboxes/box@mail.build/emails/existing',{method:'DELETE'},env as never);
 expect(res.status).toBe(500);
 expect([...open.entries()]).toEqual([]);
});
