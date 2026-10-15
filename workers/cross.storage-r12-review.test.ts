import { expect,it } from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {resolve} from 'node:path';
import {app} from './index';

it('aliases of one mailbox must share the same row charge',async()=>{
 const bundle=await build({stdin:{contents:`
 export {OwnerDO} from './workers/ownerDO';
 export {MailboxDO} from './workers/durableObject/index';
 export default {fetch(){return new Response('ok')}};
 `,resolveDir:resolve('.'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const mf=new Miniflare(convertV4MiniflareOptions({name:'r9-review',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-11-28',compatibilityFlags:['nodejs_compat'],durableObjects:{OWNER:{className:'OwnerDO',useSQLite:true},MAILBOX:{className:'MailboxDO',useSQLite:true}}}));
 try{
  const ns:any=await mf.getDurableObjectNamespace('OWNER'), mb:any=await mf.getDurableObjectNamespace('MAILBOX');
  const account='account', address='box@mail.build';
  const ledger:any=ns.get(ns.idFromName(account)),box:any=mb.get(mb.idFromName(address));
  await ledger.reserve(account,address,'box',10);
  await box.createEmail('draft',{id:'kept',body:'k'.repeat(80)},[]);
  let storedId='';
  const env={
   OWNER:{idFromName:(s:string)=>s,get:()=>({
    plan:async()=>'free',rememberPlan:async()=>{},
    reserveStorage:(...a:any[])=>ledger.reserveStorage(...a),
    cancelStorage:(...a:any[])=>ledger.cancelStorage(...a),
    commitStorage:(...a:any[])=>ledger.commitStorage(...a),
   })},
   BUCKET:{get:async()=>({json:async()=>({owner:account})})},
   MAILBOX:{idFromName:(s:string)=>s,get:()=>({
    measureEmailBytes:(id:string)=>box.measureEmailBytes(id),
    createEmail:async(...a:any[])=>{
     const result=await box.createEmail(...a);storedId=result.id;
     // A concurrent request sees this committed row and completes its deletion.
     const deletion=await ledger.openStorageDelete(account,await box.measureEmailBytes(storedId),address+'/'+storedId);
     await box.deleteEmail(storedId);
     await ledger.completeStorageDelete(account,deletion.id);
     throw new Error('injected lost create response; other request already deleted row');
    },
   })},
  };
  const res=await app.request('/api/v1/mailboxes/Box+alias@mail.build/drafts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:'x'.repeat(20)})},env as never);
  expect(res.status).toBe(500);
  expect(await box.measureEmailBytes(storedId)).toBe(null);
  const charged=await ledger.reserveStorage(account,0,100);
  const next=await ledger.reserveStorage(account,21,100);
  expect({charged:charged.used,actual:await box.usageBytes(),nextAllowed:next.ok}).toEqual({charged:80,actual:80,nextAllowed:false});
 }finally{await mf.dispose();}
},30000);
