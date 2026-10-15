import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { resolve } from 'node:path';
import { app } from './index';
import { reserveStoredBytes, releaseStoredBytes } from './lib/storageQuota';

async function withOwner(body:string, verify:(result:any)=>void){
 const result=await build({stdin:{contents:`
  import {DurableObject} from 'cloudflare:workers';
  import {OwnerDO} from './workers/ownerDO';
  export class TestOwner extends OwnerDO { constructor(ctx,env){super(ctx,{...env,BUCKET:env.BUCKET_DO.get(env.BUCKET_DO.idFromName('bucket'))});} }
  export class UsageMailbox extends DurableObject { bytes=0;async setUsage(n){this.bytes=n;}async usageBytes(){return this.bytes;} }
  export class BucketDO extends DurableObject {
    calls=0; pending; unblock;
    async arm(){this.pending=new Promise(resolve=>this.unblock=resolve);}
    async delete(keys){if(this.pending){if(++this.calls===2)this.unblock();await this.pending;}}
  }
  export default {async fetch(request,env){const owner='account';const account=env.OWNER.get(env.OWNER.idFromName(owner));const box=env.MAILBOX.get(env.MAILBOX.idFromName('box@mail.build'));const bucket=env.BUCKET_DO.get(env.BUCKET_DO.idFromName('bucket'));${body}}};
 `,resolveDir:resolve('.'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const mf=new Miniflare(convertV4MiniflareOptions({name:'r3-review',modules:true,script:result.outputFiles[0].text,compatibilityDate:'2025-11-28',durableObjects:{OWNER:{className:'TestOwner',useSQLite:true},MAILBOX:{className:'UsageMailbox',useSQLite:true},BUCKET_DO:{className:'BucketDO',useSQLite:true}}}));
 try{verify(await(await mf.dispatchFetch('https://test/')).json());}finally{await mf.dispose();}
}

it('another write seeding between physical deletion and its refund cannot double-credit deletion',async()=>{
 await withOwner(`
  await account.reserve(owner,'box@mail.build','box',10);
  await box.setUsage(100);
  // Deletion finished in MailboxDO; its refund is delayed behind another request.
  await box.setUsage(80);
  await account.reserveStorage(owner,1,100);
  await box.setUsage(81);
  await account.releaseStorage(owner,20);
  return Response.json({counter:(await account.reserveStorage(owner,0,100)).used,actual:await box.usageBytes()});
 `,r=>expect(r).toEqual({counter:81,actual:81}));
},30000);

it('two concurrent orphan sweeps refund one cleanup record only once',async()=>{
 await withOwner(`
  await account.reserveStorage(owner,100,200);
  await account.retainOrphans(['orphan-key'],20);
  await bucket.arm();
  await Promise.all([account.reserveStorage(owner,0,200),account.reserveStorage(owner,0,200)]);
  return Response.json(await account.reserveStorage(owner,0,200));
 `,r=>expect(r).toMatchObject({ok:true,used:80}));
},30000);

it('caller-supplied short thread IDs cannot be stored indefinitely with a zero charge',async()=>{
 let used=0;const stored:string[]=[];let tail=Promise.resolve();
 const storage={transaction<T>(fn:(tx:{get:(k:string)=>Promise<unknown>;put:(k:string,v:unknown)=>Promise<void>})=>Promise<T>){const run=tail.then(()=>fn({get:async()=>used,put:async(_k,v)=>{used=Number(v);}}));tail=run.then(()=>undefined,()=>undefined);return run;}};
 const env={BUCKET:{get:async()=>({json:async()=>({owner:'account'})})},
  OWNER:{idFromName:(s:string)=>s,get:()=>({plan:async()=>'free',rememberPlan:async()=>{},reserveStorage:async(_o:string,n:number)=>reserveStoredBytes(storage,n,350),releaseStorage:async(_o:string,n:number)=>releaseStoredBytes(storage,n)})},
  MAILBOX:{idFromName:(s:string)=>s,get:()=>({createEmail:async(_f:string,row:{thread_id:string})=>{stored.push(row.thread_id);return{created:true,id:'id'};}})}};
 for(let i=0;i<20;i++)await app.request('/api/v1/mailboxes/box@mail.build/drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:'',subject:'',to:'',thread_id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`})},env as never);
 expect({charged:used,storedBytes:stored.reduce((n,s)=>n+s.length,0)}).toSatisfy((r:{charged:number;storedBytes:number})=>r.charged>=r.storedBytes && r.storedBytes<=350);
});
