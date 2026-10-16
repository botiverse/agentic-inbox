import { expect, it } from 'vitest';
import { Hono } from 'hono';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { resolve } from 'node:path';
import { app } from './index';
import type { MailboxContext } from './lib/mailbox';

function sendAsPro(path: string, init: RequestInit, env: unknown) {
 const api = new Hono<MailboxContext>();
 api.use('*', async (c, next) => { c.set('authOwner', 'raft:server:human:user'); c.set('authPlan', 'pro'); await next(); });
 api.route('/', app);
 return api.request(path, init, env as never);
}


async function withOwner(body: string, verify: (value: any) => void) {
 const result = await build({stdin:{contents:`
  import {DurableObject} from 'cloudflare:workers';
  export {OwnerDO} from './workers/ownerDO';
  export class UsageMailbox extends DurableObject {
    bytes=0; reads=0; waiting; unblock;
    async setUsage(n,barrier=false){this.bytes=n;if(barrier)this.waiting=new Promise(r=>this.unblock=r);}
    async usageBytes(){if(this.waiting){if(++this.reads===2)this.unblock();await this.waiting;}return this.bytes;}
  }
  export default {async fetch(request,env){
   const owner='account';const account=env.OWNER.get(env.OWNER.idFromName(owner));
   const box=env.MAILBOX.get(env.MAILBOX.idFromName('box@mail.build'));
   ${body}
  }};`,resolveDir:resolve('.'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const mf=new Miniflare(convertV4MiniflareOptions({name:'r2-review',modules:true,script:result.outputFiles[0].text,compatibilityDate:'2025-11-28',durableObjects:{OWNER:{className:'OwnerDO',useSQLite:true},MAILBOX:{className:'UsageMailbox',useSQLite:true}}}));
 try {verify(await (await mf.dispatchFetch('https://test/')).json());} finally {await mf.dispose();}
}

it('two concurrent first deletes cannot both be reflected in the seed and then deducted again',async()=>{
 await withOwner(`
   await account.reserve(owner,'box@mail.build','box',10);
   await box.setUsage(100);
   const a=await account.openStorageDelete(owner,10);
   const b=await account.openStorageDelete(owner,10);
   await box.setUsage(80);
   await Promise.all([account.completeStorageDelete(owner,a.id),account.completeStorageDelete(owner,b.id)]);
   return Response.json({counter:(await account.reserveStorage(owner,0,100)).used,actual:await box.usageBytes()});
 `,value=>expect(value).toEqual({counter:80,actual:80}));
},30000);

it('releasing a mailbox slot cannot free the storage budget while its data is retained',async()=>{
 await withOwner(`
   await account.reserve(owner,'box@mail.build','box',10);
   await box.setUsage(100);
   await account.reserveStorage(owner,0,100);
   await account.release(owner,'box@mail.build');
   await account.reserve(owner,'newbox@mail.build','new',10);
   return Response.json({retained:await box.usageBytes(),admission:await account.reserveStorage(owner,1,100)});
 `,value=>expect(value).toMatchObject({retained:100,admission:{ok:false,used:100}}));
},30000);

function ledger() {
 let committed=0; const holds=new Map<string,number>(); const deletes=new Map<string,number>(); let seq=0;
 const occupied=()=>{let pending=0; for (const n of deletes.values()) pending+=n; return Math.max(0,committed-pending);};
 return {get used(){return occupied();},binding:{idFromName:(s:string)=>s,get:()=>({plan:async()=>'free',rememberPlan:async()=>{},
  reserveSend:async()=>({ok:true,retryAt:Date.now()+86_400_000}),
  reserveStorage:async(_o:string,bytes:number)=>{const add=Math.max(0,Math.floor(bytes)); const visible=occupied(); if(add>0&&visible+add>350) return {ok:false,used:visible,limit:350}; const id=`h${++seq}`; if(add>0){holds.set(id,add); committed+=add;} return {ok:true,used:occupied(),limit:350,id};},
  cancelStorage:async(_o:string,id:string)=>{const n=holds.get(id)??0; if(holds.delete(id)) committed=Math.max(0,committed-n); return {used:occupied()};},
  commitStorage:async(_o:string,id:string)=>{holds.delete(id); return {used:occupied()};},
  openStorageDelete:async()=>({id:'',used:occupied()}),
  completeStorageDelete:async(_o:string,id:string)=>({used:occupied()}),
  abortStorageDelete:async()=>({used:occupied()}),
  retainOrphans:async(_k:string[],bytes:number,holdId?:string)=>{if(holdId) holds.delete(holdId); committed=Math.max(0,committed-bytes);},
 })}};
}

it('an R2 put that commits then throws must not leave an uncharged object',async()=>{
 const account=ledger(), objects=new Map<string,number>();let puts=0;
 const env={BUCKET:{get:async()=>({json:async()=>({owner:'owner'})}),
  put:async(k:string,v:Uint8Array)=>{objects.set(k,v.byteLength);if(++puts===2)throw new Error('response lost after put');},
  delete:async(keys:string[])=>{for(const key of keys)objects.delete(key);}},
  MAILBOX:{idFromName:(s:string)=>s,get:()=>({checkSendRateLimit:async()=>null})},OWNER:account.binding};
 const response=await sendAsPro('/api/v1/mailboxes/box@mail.build/emails',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:'other@example.com',from:'box@mail.build',subject:'s',text:'body',attachments:[{content:btoa('1234'),filename:'one',type:'text/plain',disposition:'attachment'},{content:btoa('5678'),filename:'two',type:'text/plain',disposition:'attachment'}]})},env);
 expect(response.status).toBe(500);
 expect({charged:account.used,r2Bytes:[...objects.values()].reduce((a,b)=>a+b,0)}).toEqual({charged:0,r2Bytes:0});
});

it('uncharged recipient metadata cannot replace subject as unlimited storage',async()=>{
 const account=ledger();const stored:Array<{recipient:string}>=[];
 const env={BUCKET:{get:async()=>({json:async()=>({owner:'owner'})})},MAILBOX:{idFromName:(s:string)=>s,get:()=>({createEmail:async(_f:string,row:{recipient:string})=>{stored.push(row);return{created:true,id:'id'};}})},OWNER:account.binding};
 const response=await app.request('/api/v1/mailboxes/box@mail.build/drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:'',subject:'',to:'x'.repeat(1000)})},env as never);
 expect({status:response.status,charged:account.used,persisted:stored.reduce((a,b)=>a+b.recipient.length,0)}).toEqual({status:413,charged:0,persisted:0});
});
