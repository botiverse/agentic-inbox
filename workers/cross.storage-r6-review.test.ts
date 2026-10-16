import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { resolve } from 'node:path';

async function check(body:string,verify:(value:any)=>void){
 const bundle=await build({stdin:{contents:`
  import {DurableObject} from 'cloudflare:workers';
  import {OwnerDO as RealOwner} from './workers/ownerDO'; export class OwnerDO extends RealOwner {constructor(ctx,env){super(ctx,{...env,BUCKET:{delete:async()=>{throw new Error('R2 cleanup unavailable');}}});}}
  export class UsageMailbox extends DurableObject {bytes=0;async setUsage(n){this.bytes=n;}async usageBytes(){return this.bytes;}}
  export default {async fetch(request,env){const owner='account';const account=env.OWNER.get(env.OWNER.idFromName(owner));const box=env.MAILBOX.get(env.MAILBOX.idFromName('box@mail.build'));${body}}};
 `,resolveDir:resolve('.'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const mf=new Miniflare(convertV4MiniflareOptions({name:'r4-review',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-11-28',durableObjects:{OWNER:{className:'OwnerDO',useSQLite:true},MAILBOX:{className:'UsageMailbox',useSQLite:true}}}));
 try{verify(await(await mf.dispatchFetch('https://test/')).json());}finally{await mf.dispose();}
}


it('orphan bytes kept in R2 must count even after their hold is retired',async()=>{
 await check(`
  await account.reserve(owner,'box@mail.build','box',10);
  await box.setUsage(80);
  const held=await account.reserveStorage(owner,20,100);
  if(!held.ok)throw new Error('setup hold rejected');
  // An attempted R2 put left 20 bytes; row creation/cleanup failed.
  await account.retainOrphans(['persisting-object'],20,held.id);
  const next=await account.reserveStorage(owner,1,100);
  return Response.json({allowed:next.ok,counter:next.used,existingBytes:100});
 `,v=>expect(v).toEqual({allowed:false,counter:100,existingBytes:100}));
},30000);

it('a write admitted before mailbox release remains counted after it commits',async()=>{
 await check(`
  await account.reserve(owner,'box@mail.build','box',10);
  await box.setUsage(80);
  const held=await account.reserveStorage(owner,20,100);
  if(!held.ok)throw new Error('setup hold rejected');
  // Concurrent mailbox release snapshots 80 while this write is in flight.
  await account.release(owner,'box@mail.build');
  await box.setUsage(100);
  await account.commitStorage(owner,held.id);
  await account.reserve(owner,'other@mail.build','other',10);
  const next=await account.reserveStorage(owner,1,100);
  return Response.json({allowed:next.ok,counter:next.used,retainedActual:await box.usageBytes()});
 `,v=>expect(v).toEqual({allowed:false,counter:100,retainedActual:100}));
},30000);
