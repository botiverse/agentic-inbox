import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {resolve} from 'node:path';
import {app} from './index';

it('failed deletion abort cannot let both orphan sweep and deletion completion refund the same bytes',async()=>{
 const bundle=await build({stdin:{contents:`
  import {DurableObject} from 'cloudflare:workers';
  import {OwnerDO as ActualOwner} from './workers/ownerDO';
  export class OwnerDO extends ActualOwner {constructor(ctx,env){super(ctx,{...env,BUCKET:{delete:async()=>{}}});}}
  export class UsageMailbox extends DurableObject {bytes=0;async setUsage(n){this.bytes=n;}async usageBytes(){return this.bytes;}}
  export default {fetch(){return new Response('ok')}};
 `,resolveDir:resolve('.'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const mf=new Miniflare(convertV4MiniflareOptions({name:'r8-review',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-11-28',durableObjects:{OWNER:{className:'OwnerDO',useSQLite:true},MAILBOX:{className:'UsageMailbox',useSQLite:true}}}));
 try{
  const ns:any=await mf.getDurableObjectNamespace('OWNER');
  const mb:any=await mf.getDurableObjectNamespace('MAILBOX');
  const owner='account', address='box@mail.build';
  const ledger:any=ns.get(ns.idFromName(owner));
  const box:any=mb.get(mb.idFromName(address));
  await ledger.reserve(owner,address,'box',10);
  await box.setUsage(100);
  await ledger.reserveStorage(owner,0,100);
  let abortCalls=0;
  const env={
   OWNER:{idFromName:(s:string)=>s,get:()=>({
    openStorageDelete:(...a:any[])=>ledger.openStorageDelete(...a),
    retainOrphans:(...a:any[])=>ledger.retainOrphans(...a),
    completeStorageDelete:(...a:any[])=>ledger.completeStorageDelete(...a),
    abortStorageDelete:async(...a:any[])=>{if(++abortCalls===1)throw new Error('abort RPC failed before reaching OwnerDO');return ledger.abortStorageDelete(...a);},
   })},
   MAILBOX:{idFromName:(s:string)=>s,get:()=>({
    measureEmailBytes:async()=>20,
    deleteEmail:async()=>{await box.setUsage(80);return[{id:'att',filename:'a.bin'}];},
   })},
   BUCKET:{get:async()=>({json:async()=>({owner})}),delete:async()=>{throw new Error('first R2 delete failed; later sweep succeeds');}},
  };
  const res=await app.request('/api/v1/mailboxes/box@mail.build/emails/old-mail',{method:'DELETE'},env as never);
  expect(res.status).toBe(500);
  const result=await ledger.reserveStorage(owner,0,100);
  const next=await ledger.reserveStorage(owner,21,100);
  expect({counter:result.used,actual:await box.usageBytes(),nextAllowed:next.ok}).toEqual({counter:80,actual:80,nextAllowed:false});
 }finally{await mf.dispose();}
},30000);
