import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { resolve } from 'node:path';
import { app } from './index';
import { reserveStoredBytes, releaseStoredBytes } from './lib/storageQuota';

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
   // Two messages of ten bytes have just been deleted; both releases enter before seeding.
   await box.setUsage(80,true);
   await Promise.all([account.releaseStorage(owner,10),account.releaseStorage(owner,10)]);
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
 let used=0;let tail=Promise.resolve();
 const storage={transaction<T>(fn:(tx:{get:(k:string)=>Promise<unknown>;put:(k:string,v:unknown)=>Promise<void>})=>Promise<T>){
  const result=tail.then(()=>fn({get:async()=>used,put:async(_k,v)=>{used=Number(v);}}));tail=result.then(()=>undefined,()=>undefined);return result;
 }};
 return {get used(){return used;},binding:{idFromName:(s:string)=>s,get:()=>({plan:async()=>'free',rememberPlan:async()=>{},reserveStorage:async(_o:string,n:number)=>reserveStoredBytes(storage,n,350),releaseStorage:async(_o:string,n:number)=>releaseStoredBytes(storage,n)})}};
}

it('an R2 put that commits then throws must not leave an uncharged object',async()=>{
 const account=ledger(), objects=new Map<string,number>();let puts=0;
 const env={BUCKET:{get:async()=>({json:async()=>({owner:'owner'})}),
  put:async(k:string,v:Uint8Array)=>{objects.set(k,v.byteLength);if(++puts===2)throw new Error('response lost after put');},
  delete:async(keys:string[])=>{for(const key of keys)objects.delete(key);}},
  MAILBOX:{idFromName:(s:string)=>s,get:()=>({checkSendRateLimit:async()=>null})},OWNER:account.binding};
 const response=await app.request('/api/v1/mailboxes/box@mail.build/emails',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:'other@example.com',from:'box@mail.build',subject:'s',text:'body',attachments:[{content:btoa('1234'),filename:'one',type:'text/plain',disposition:'attachment'},{content:btoa('5678'),filename:'two',type:'text/plain',disposition:'attachment'}]})},env as never);
 expect(response.status).toBe(500);
 expect({charged:account.used,r2Bytes:[...objects.values()].reduce((a,b)=>a+b,0)}).toEqual({charged:0,r2Bytes:0});
});

it('uncharged recipient metadata cannot replace subject as unlimited storage',async()=>{
 const account=ledger();const stored:Array<{recipient:string}>=[];
 const env={BUCKET:{get:async()=>({json:async()=>({owner:'owner'})})},MAILBOX:{idFromName:(s:string)=>s,get:()=>({createEmail:async(_f:string,row:{recipient:string})=>{stored.push(row);return{created:true,id:'id'};}})},OWNER:account.binding};
 const response=await app.request('/api/v1/mailboxes/box@mail.build/drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:'',subject:'',to:'x'.repeat(1000)})},env as never);
 expect({status:response.status,charged:account.used,persisted:stored.reduce((a,b)=>a+b.recipient.length,0)}).toEqual({status:413,charged:0,persisted:0});
});
