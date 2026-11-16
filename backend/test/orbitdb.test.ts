import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Wallet} from 'ethers';
import {OrbitDbCiphertextStore,type OrbitDocuments} from '../src/orbitdb-store.ts';
import {OrbitDbClient,configuredCiphertextStore} from '../src/orbitdb-client.ts';
import {executeOrbitRequest} from '../src/orbitdb-server.ts';
import {EncryptedStorage,type StorageChain} from '../src/storage.ts';
import {DocumentService} from '../src/document-service.ts';
import {documentMessage} from '../src/document-protocol.ts';
import {openingMessage} from '../src/opening-protocol.ts';
import {verifySelectedPart} from '../src/opening-worker.ts';
import {PROTOCOL,encryptPart,sha,bytes,base64,canonicalBundle,storageMessage,MAX_FILE_BYTES} from '../src/bid-protocol.ts';
import {ApiError} from '../src/errors.ts';
// Contract double only: this exercises record logic, not the external OrbitDB engine.
function sorted(value:any):any{return Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;}
class DocumentsDouble implements OrbitDocuments {
 records=new Map<string,Record<string,unknown>>();writes=0;failAt=0;
 async get(key:string){const value=this.records.get(key);return value?{key,value:structuredClone(value)}:undefined;}
 async put(value:Record<string,unknown>){if(++this.writes===this.failAt)throw new Error('Simulated interrupted append');this.records.set(value._id as string,sorted(value));}
 async *iterator(){for(const [key,value]of this.records)yield {key,value:structuredClone(value)};}
}
const owner=Wallet.createRandom(),service=Wallet.createRandom(),commission=Wallet.createRandom();
const pair=generateKeyPairSync('rsa',{modulusLength:3072}),der=new Uint8Array(pair.publicKey.export({type:'spki',format:'der'})),fingerprint=await sha(der);
const context={chainId:'31337',workflow:'0x0000000000000000000000000000000000000001',tenderId:'1',bidder:owner.address.toLowerCase(),version:'1'};
async function fixture(maximum=false){
 const bundle={protocol:PROTOCOL,context,parts:await Promise.all((maximum?[0,1,2]:[0,2]).map(part=>encryptPart(context,part,{name:'private-offer.txt',type:'text/plain',data:maximum?new Uint8Array(MAX_FILE_BYTES).fill(65):bytes('PRIVATE OFFER CONTENT')},der,fingerprint)))};
 const serialized=canonicalBundle(bundle),id=await sha(bytes(serialized)),database=new DocumentsDouble(),store=new OrbitDbCiphertextStore(database);return {bundle,serialized,id,database,store};
}
test('OrbitDB adapter stores actual encrypted contents in one record per part and commits last',async()=>{
 const {store,id,serialized,database,bundle}=await fixture();await store.put(id,serialized);
 assert.equal(database.records.size,3);assert.equal(database.records.get(id+':0')?.kind,'part');assert.deepEqual((database.records.get(id+':0')?.part as any).ciphertext,bundle.parts[0].ciphertext);
 assert.equal([...database.records.keys()].at(-1),id);assert.equal(await store.get(id),serialized);assert.deepEqual(await store.ids(),[id]);
 assert.ok(!JSON.stringify([...database.records.values()]).includes('PRIVATE OFFER CONTENT'));assert.ok(!JSON.stringify([...database.records.values()]).includes('private-offer.txt'));
});
test('Maximum three-part payload retains independently verifiable encryption',async()=>{
 const {store,id,serialized,bundle}=await fixture(true);await store.put(id,serialized);const restored=JSON.parse((await store.get(id))!);
 for(const part of restored.parts){const result=await verifySelectedPart({context,part:part.part,service:service.address.toLowerCase(),timestamp:Date.now().toString()},{contentId:id,context,part,authorizedAtBlock:1},{blockNumber:1,fingerprint,evidence:part.evidence},pair.privateKey);assert.equal(result.verified,true);}
 assert.equal(restored.parts.length,bundle.parts.length);
});
test('Idempotent concurrent retries do not duplicate database records despite canonical property reordering',async()=>{
 const {store,id,serialized,database}=await fixture();await Promise.all([store.put(id,serialized),store.put(id,serialized)]);assert.equal(database.writes,3);assert.equal(await store.get(id),serialized);
});
test('Interrupted part writes stay invisible and exact retry completes the package',async()=>{
 const {store,id,serialized,database}=await fixture();database.failAt=2;await assert.rejects(store.put(id,serialized),/interrupted/);
 assert.deepEqual(await store.ids(),[]);assert.equal(await store.get(id),undefined);assert.equal(database.records.size,1);
 database.failAt=0;await store.put(id,serialized);assert.equal(database.records.size,3);assert.equal(await store.get(id),serialized);
});
test('Missing and corrupted database parts never return a complete package',async()=>{
 for(const mode of ['missing','ciphertext','context','manifest']){
  const {store,id,serialized,database}=await fixture();await store.put(id,serialized);const record=database.records.get(id+':0')!;
  if(mode==='missing')database.records.delete(id+':0');
  if(mode==='ciphertext')(record.part as any).ciphertext='AAAA';
  if(mode==='context')(record.context as any).tenderId='2';
  if(mode==='manifest')database.records.get(id)!.parts=[0,0];
  await assert.rejects(store.get(id),{code:'STORAGE_CORRUPT'});
 }
});
test('Wrong content ID, extra plaintext fields and noncanonical packages are rejected before writes',async()=>{
 const {store,id,serialized,database,bundle}=await fixture();
 for(const [key,value]of [['../../private',serialized],['0x'+'1'.repeat(64),serialized],[id,JSON.stringify({...bundle,plaintext:'LEAK'})],[id,' '+serialized]])await assert.rejects(store.put(key,value));
 assert.equal(database.writes,0);
});
test('Quota accounts for incomplete records and prevents partial new writes',async()=>{
 const {database,id,serialized}=await fixture();const store=new OrbitDbCiphertextStore(database,1);await assert.rejects(store.put(id,serialized),{code:'STORAGE_FULL'});assert.equal(database.writes,0);
});
test('Existing uncommitted records cannot be silently overwritten during retry',async()=>{
 const {store,database,id,serialized}=await fixture();database.records.set(id+':0',{_id:id+':0',kind:'part',ciphertext:'substituted'});await assert.rejects(store.put(id,serialized),{code:'STORAGE_CORRUPT'});
});
test('Configured OrbitDB access fails unavailable without falling back to filesystem',async()=>{
 const store=configuredCiphertextStore({STORAGE_PROVIDER:'orbitdb',ORBITDB_SOCKET:'/tmp/constructblock-no-such-orbitdb.sock'});assert.ok(store instanceof OrbitDbClient);await assert.rejects(store.ids(),{code:'ORBITDB_UNAVAILABLE'});
 assert.throws(()=>configuredCiphertextStore({STORAGE_PROVIDER:'typo'}),/STORAGE_PROVIDER/);assert.throws(()=>new OrbitDbClient('relative.sock'),/absolute/);
});
test('Document-side database client rejects writes locally',async()=>{await assert.rejects(new OrbitDbClient('/tmp/unused-orbitdb.sock',true).put('0x'+'1'.repeat(64),'{}'),{code:'STORAGE_READ_ONLY'});});
test('Signed bidder upload, protected opening and audited document viewing share the database adapter',async()=>{
 const {store,bundle,id}=await fixture(),root=await mkdtemp(join(tmpdir(),'cb-orbitdb-policy-'));let allowed=false,keyReads=0;
 const access={blockNumber:7,fingerprint,evidence:bundle.parts[0].evidence};
 const chain:StorageChain={status:async()=>({ready:true,chainId:'31337',expectedChainId:'31337',blockNumber:7,contracts:{roleRegistry:commission.address,procurementWorkflow:context.workflow,registryLinked:true}}),bidderStatus:async address=>({address,approved:true,blockNumber:7}),bidAccess:async()=>({state:0,deadline:String(Math.floor(Date.now()/1000)+3600),chainTime:Math.floor(Date.now()/1000),version:'0',active:false,paused:false,requiresTechnicalOffer:false,fingerprints:[fingerprint,'',fingerprint]})};
 const guarded={...chain,openingAccess:async()=>{if(!allowed)throw new ApiError(403,'OPENING_NOT_AUTHORIZED','Not requested');return access;},documentAccess:async()=>{if(!allowed)throw new ApiError(403,'DOCUMENT_STAGE_LOCKED','Not authorized');return access;}};
 try{
  await mkdir(join(root,'keys'));await writeFile(join(root,'keys',fingerprint+'.json'),JSON.stringify({fingerprint,spki:base64(der)}));
  const storage=new EncryptedStorage(guarded,join(root,'unused-objects'),join(root,'keys'),undefined,store);
  const timestamp=Date.now().toString();await assert.rejects(storage.upload(bundle,timestamp,''),{code:'INVALID_SIGNATURE'});
  await storage.upload(bundle,timestamp,await owner.signMessage(storageMessage('upload',context,id,timestamp)));
  const download=await owner.signMessage(storageMessage('download',context,id,timestamp));assert.deepEqual(await storage.retrieve(id,context,timestamp,download),bundle);
  const request={context,part:0,service:service.address.toLowerCase(),timestamp},signature=await service.signMessage(openingMessage(request));await assert.rejects(storage.retrieveOpening(request,signature),{code:'OPENING_NOT_AUTHORIZED'});
  allowed=true;assert.equal((await storage.retrieveOpening(request,signature)).part.ciphertext,bundle.parts[0].ciphertext);
  const documentService=new DocumentService(guarded,storage,async()=>{keyReads++;return pair.privateKey;},join(root,'audit'));
  const view={context,part:0,viewer:commission.address.toLowerCase(),timestamp:Date.now().toString(),nonce:'0x'+'7'.repeat(32)};
  const viewed=await documentService.view(view,await commission.signMessage(documentMessage(view)));assert.equal(Buffer.from(viewed.document.data,'base64').toString(),'PRIVATE OFFER CONTENT');assert.equal(keyReads,1);
  assert.equal((await store.ids()).length,1);await assert.rejects(stat(join(root,'unused-objects')),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Storage owner protocol allows only bounded encrypted operations',async()=>{
 const {store,id,serialized}=await fixture(),info={provider:'orbitdb',sync:false};
 assert.deepEqual(await executeOrbitRequest(store,{op:'info'},info),info);
 assert.equal(await executeOrbitRequest(store,{op:'put',contentId:id,serialized},info),id);
 assert.equal(await executeOrbitRequest(store,{op:'get',contentId:id},info),serialized);
 assert.deepEqual(await executeOrbitRequest(store,{op:'ids'},info),[id]);
 for(const request of [{op:'decrypt'},{op:'get',contentId:'../key.pem'},{op:'put',contentId:id,serialized,privateKey:'LEAK'},null])await assert.rejects(executeOrbitRequest(store,request,info),{code:'INVALID_PACKAGE'});
});
