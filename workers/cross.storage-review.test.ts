import { describe, expect, it } from "vitest";
import { app } from "./index";
import { reserveStoredBytes, releaseStoredBytes } from "./lib/storageQuota";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { resolve } from "node:path";

it("existing usage cannot be credited twice when the first quota operation is a delete", async () => {
 const result = await build({stdin:{contents:`
  import { DurableObject } from "cloudflare:workers";
  export { OwnerDO } from "./workers/ownerDO";
  export class UsageMailbox extends DurableObject {
    async setUsage(n) { await this.ctx.storage.put("bytes", n); }
    async usageBytes() { return await this.ctx.storage.get("bytes") || 0; }
  }
  export default { async fetch(request,env) {
    const owner="existing-account";
    const account=env.OWNER.get(env.OWNER.idFromName(owner));
    const mailbox=env.MAILBOX.get(env.MAILBOX.idFromName("box@mail.build"));
    await account.reserve(owner,"box@mail.build","box",10);
    await mailbox.setUsage(100);
    // HTTP DELETE removes the mail before calling reclaimStorage/releaseStorage.
    await mailbox.setUsage(80);
    const released=await account.releaseStorage(owner,20);
    return Response.json({counter:released.used, actual:await mailbox.usageBytes()});
  }};`,resolveDir:resolve('.'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const mf=new Miniflare(convertV4MiniflareOptions({name:'review-delete',modules:true,script:result.outputFiles[0].text,compatibilityDate:'2025-11-28',durableObjects:{OWNER:{className:'OwnerDO',useSQLite:true},MAILBOX:{className:'UsageMailbox',useSQLite:true}}}));
 try {const value=await (await mf.dispatchFetch('https://test/')).json();expect(value).toEqual({counter:80,actual:80});}
 finally {await mf.dispose();}
},30000);

it("adding an already-populated mailbox after the account was seeded cannot bypass the cap", async () => {
 const result=await build({stdin:{contents:`
  import { DurableObject } from "cloudflare:workers";
  export { OwnerDO } from "./workers/ownerDO";
  export class UsageMailbox extends DurableObject { async usageBytes(){return 100;} }
  export default {async fetch(request,env){
    const owner="adopting-account";const account=env.OWNER.get(env.OWNER.idFromName(owner));
    await account.reserveStorage(owner,0,100);
    // Claim/adoption adds this mailbox to the registry, but its existing bytes need charging.
    await account.reserve(owner,"old-box@mail.build","old",10);
    return Response.json(await account.reserveStorage(owner,1,100));
  }};`,resolveDir:resolve('.'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const mf=new Miniflare(convertV4MiniflareOptions({name:'review-adopt',modules:true,script:result.outputFiles[0].text,compatibilityDate:'2025-11-28',durableObjects:{OWNER:{className:'OwnerDO',useSQLite:true},MAILBOX:{className:'UsageMailbox',useSQLite:true}}}));
 try {const value=await (await mf.dispatchFetch('https://test/')).json();expect(value).toMatchObject({ok:false,used:100});}
 finally {await mf.dispose();}
},30000);

function ledger(initial:number) {
 let used=initial;let tail=Promise.resolve();
 const store={transaction<T>(f:(tx:{get:(key:string)=>Promise<unknown>;put:(key:string,v:unknown)=>Promise<void>})=>Promise<T>){
  const run=tail.then(()=>f({get:async()=>used,put:async(_k,v)=>{used=Number(v);}}));tail=run.then(()=>undefined,()=>undefined);return run;
 }};
 return {get used(){return used;}, binding:{idFromName:(s:string)=>s,get:()=>({
  plan:async()=>"free",rememberPlan:async()=>{},
  reserveStorage:async(_o:string,bytes:number)=>reserveStoredBytes(store,bytes,350),
  releaseStorage:async(_o:string,bytes:number)=>releaseStoredBytes(store,bytes),
 })}};
}

it("concurrent replacements of the same old draft cannot spend its old-byte credit twice",async()=>{
 const account=ledger(100);const messages=new Map([['old',100]]);let reads=0;let unblock!:()=>void;
 const bothRead=new Promise<void>(r=>{unblock=r;});
 const stub={
  measureEmailBytes:async(id:string)=>{const size=messages.get(id);reads++;if(reads===2)unblock();await bothRead;return size??null;},
  deleteEmail:async(id:string)=>messages.delete(id)?[]:null,
  createEmail:async(_f:string,row:{id:string;body:string})=>{messages.set(row.id,new TextEncoder().encode(row.body).length);return {created:true,id:row.id};},
 };
 const env={BUCKET:{get:async()=>({json:async()=>({owner:'owner'})})},MAILBOX:{idFromName:(s:string)=>s,get:()=>stub},OWNER:account.binding};
 const requests=await Promise.all([1,2].map(()=>app.request('/api/v1/mailboxes/box@mail.build/drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft_id:'old',body:'x'.repeat(200)})},env as never)));
 const actual=[...messages.values()].reduce((a,b)=>a+b,0);
 expect({statuses:requests.map(r=>r.status),counter:account.used,actual}).toEqual({statuses:[201,409],counter:200,actual:200});
});

it("a failed attachment batch cannot refund quota while leaving R2 objects behind",async()=>{
 const account=ledger(0);const objects=new Map<string,number>();let puts=0;
 const env={
  BUCKET:{get:async()=>({json:async()=>({owner:'owner'})}),put:async(k:string,b:Uint8Array)=>{if(++puts===2)throw new Error('injected R2 failure');objects.set(k,b.byteLength);},delete:async(keys:string[])=>{for(const k of keys)objects.delete(k);}},
  MAILBOX:{idFromName:(s:string)=>s,get:()=>({checkSendRateLimit:async()=>null,createEmail:async()=>{throw new Error('should not reach');}})},OWNER:account.binding,
 };
 const response=await app.request('/api/v1/mailboxes/box@mail.build/emails',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:'someone@example.com',from:'box@mail.build',subject:'s',text:'body',attachments:[{content:btoa('1234'),filename:'one',type:'text/plain',disposition:'attachment'},{content:btoa('5678'),filename:'two',type:'text/plain',disposition:'attachment'}]})},env as never);
 expect(response.status).toBe(500);
 const actual=[...objects.values()].reduce((a,b)=>a+b,0);
 expect({counter:account.used,r2Bytes:actual}).toEqual({counter:0,r2Bytes:0});
});

it("empty-body drafts cannot persist arbitrarily large subjects while charging zero bytes",async()=>{
 const account=ledger(0);const stored: Array<{subject:string;body:string}> = [];
 const env={BUCKET:{get:async()=>({json:async()=>({owner:'owner'})})},
  MAILBOX:{idFromName:(s:string)=>s,get:()=>({createEmail:async(_f:string,row:{subject:string;body:string})=>{stored.push(row);return {created:true,id:'id'};}})},OWNER:account.binding};
 const response=await app.request('/api/v1/mailboxes/box@mail.build/drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:'x'.repeat(1_000),body:''})},env as never);
 expect({status:response.status,counter:account.used,persistedSubjectBytes:stored.reduce((sum,r)=>sum+r.subject.length,0)}).toEqual({status:413,counter:0,persistedSubjectBytes:0});
});
