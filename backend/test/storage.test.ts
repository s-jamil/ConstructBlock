import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,privateDecrypt,createDecipheriv,constants} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {Wallet} from 'ethers';
import {PROTOCOL,encryptPart,validateBundle,contextBytes,frame,concat,bytes,sha,canonicalBundle,unbase64,base64,storageMessage,type BidBundle} from '../src/bid-protocol.ts';
import {EncryptedStorage,type StorageChain} from '../src/storage.ts';
import {createApp} from '../src/app.ts';
// @ts-ignore native test transport
import {inject} from './inject.mjs';
const owner=Wallet.createRandom(),other=Wallet.createRandom();
const pair=generateKeyPairSync('rsa',{modulusLength:3072});
const spki=new Uint8Array(pair.publicKey.export({type:'spki',format:'der'}));
const fingerprint=await sha(spki);
const context={chainId:'31337',workflow:'0x0000000000000000000000000000000000000001',tenderId:'1',bidder:owner.address.toLowerCase(),version:'1'};
const file={name:'confidential-price.txt',type:'text/plain',data:bytes('SENSITIVE BID AMOUNT 123456')};
async function bundle():Promise<BidBundle>{return {protocol:PROTOCOL,context,parts:await Promise.all([0,2].map(part=>encryptPart(context,part,file,spki,fingerprint)))};}
async function fixture(fn:(x:any)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'constructblock-storage-'));const keys=join(root,'keys');await mkdir(keys);
 await writeFile(join(keys,fingerprint+'.json'),JSON.stringify({fingerprint,spki:base64(spki)}));
 let approved=true;
 const chain:StorageChain={status:async()=>({ready:true,chainId:'31337',expectedChainId:'31337',blockNumber:1,contracts:{roleRegistry:'0x0000000000000000000000000000000000000002',procurementWorkflow:context.workflow,registryLinked:true}}),bidderStatus:async(address)=>({address,approved,blockNumber:1}),bidAccess:async()=>({state:0,deadline:String(Math.floor(Date.now()/1000)+3600),chainTime:Math.floor(Date.now()/1000),version:'0',active:false,paused:false,requiresTechnicalOffer:false,fingerprints:[fingerprint,'0x'+'0'.repeat(64),fingerprint]})};
 const storage=new EncryptedStorage(chain,join(root,'objects'),keys);
 try{await fn({root,keys,chain,storage,revoke:()=>{approved=false;}});}finally{await rm(root,{recursive:true,force:true});}
}
async function auth(b:BidBundle,action:'upload'|'download'='upload',signer=owner,timestamp=Date.now().toString()){
 const contentId=await sha(bytes(canonicalBundle(b)));return {contentId,timestamp,signature:await signer.signMessage(storageMessage(action,b.context,contentId,timestamp))};
}
test('Browser encryption interoperates with independent Node RSA and AES decryption',async()=>{
 const b=await bundle();await validateBundle(b);
 const p=b.parts[0],material=privateDecrypt({key:pair.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},unbase64(p.wrapped));
 assert.equal(material.length,64);
 const cipher=Buffer.from(unbase64(p.ciphertext)),decrypt=createDecipheriv('aes-256-gcm',material.subarray(0,32),unbase64(p.nonce));
 decrypt.setAAD(contextBytes(context,0));decrypt.setAuthTag(cipher.subarray(-16));
 const plain=Buffer.concat([decrypt.update(cipher.subarray(0,-16)),decrypt.final()]);
 assert.deepEqual(JSON.parse(plain.toString()),{name:file.name,type:file.type,data:base64(file.data)});
 assert.equal(await sha(frame(contextBytes(context,0),material.subarray(32),plain)),p.evidence.commitment);
 assert.ok(!canonicalBundle(b).includes(file.name));assert.ok(!canonicalBundle(b).includes('SENSITIVE'));
});
test('Random encryption creates different ciphertext and salted commitments for identical files',async()=>{const a=await bundle(),b=await bundle();assert.notEqual(a.parts[0].ciphertext,b.parts[0].ciphertext);assert.notEqual(a.parts[0].evidence.commitment,b.parts[0].evidence.commitment);});
test('Encryption rejects a substituted opening key',async()=>{await assert.rejects(encryptPart(context,0,file,spki,'0x'+'1'.repeat(64)),/fingerprint/);});
test('Empty and oversized plaintext documents are rejected',async()=>{for(const length of [0,1024*1024+1])await assert.rejects(encryptPart(context,0,{...file,data:new Uint8Array(length)},spki,fingerprint),/1 MiB/);});
for(const field of ['ciphertext','nonce','wrapped'] as const)test(`Tampered ${field} is rejected`,async()=>{const b=await bundle();b.parts[0][field]=base64(new Uint8Array(unbase64(b.parts[0][field]).length));await assert.rejects(validateBundle(b));});
test('Changing tender context invalidates ciphertext evidence',async()=>{const b=await bundle();b.context={...context,tenderId:'2'};await assert.rejects(validateBundle(b),/hash mismatch/);});
test('Unknown fields and invalid base64 are rejected',async()=>{const b=await bundle();await assert.rejects(validateBundle({...b,plaintext:'leak'}));assert.throws(()=>unbase64('not base64!'));});
test('File upload is durable, idempotent, private and retrievable after service restart',async()=>fixture(async({storage,chain,root,keys})=>{
 const b=await bundle(),a=await auth(b);const first=await storage.upload(b,a.timestamp,a.signature);assert.equal(first.acceptedOnChain,false);
 assert.deepEqual(await storage.upload(b,a.timestamp,a.signature),first);assert.equal((await readdir(join(root,'objects'))).length,1);
 const restarted=new EncryptedStorage(chain,join(root,'objects'),keys),read=await auth(b,'download');
 assert.deepEqual(await restarted.retrieve(read.contentId,b.context,read.timestamp,read.signature),b);
 assert.ok(!(await readFile(join(root,'objects',a.contentId+'.json'),'utf8')).includes(file.name));
}));
test('Storage rejects missing, wrong-owner, expired, future and wrong-action signatures',async()=>fixture(async({storage})=>{
 const b=await bundle(),valid=await auth(b);
 await assert.rejects(storage.upload(b,valid.timestamp,''),{code:'INVALID_SIGNATURE'});
 const wrong=await auth(b,'upload',other);await assert.rejects(storage.upload(b,wrong.timestamp,wrong.signature),{code:'INVALID_SIGNATURE'});
 for(const offset of [-360000,360000]){const old=await auth(b,'upload',owner,String(Date.now()+offset));await assert.rejects(storage.upload(b,old.timestamp,old.signature),{code:'EXPIRED_AUTHORIZATION'});}
 const wrongAction=await auth(b,'download');await assert.rejects(storage.upload(b,wrongAction.timestamp,wrongAction.signature),{code:'INVALID_SIGNATURE'});
}));
test('Revoked bidder cannot upload or retrieve previously stored packages',async()=>fixture(async({storage,revoke})=>{const b=await bundle(),a=await auth(b);await storage.upload(b,a.timestamp,a.signature);revoke();await assert.rejects(storage.upload(b,a.timestamp,a.signature),{code:'NOT_BIDDER'});const r=await auth(b,'download');await assert.rejects(storage.retrieve(r.contentId,b.context,r.timestamp,r.signature),{code:'NOT_BIDDER'});}));
test('Another wallet cannot retrieve an owner package even with its own valid signature',async()=>fixture(async({storage})=>{
 const b=await bundle(),a=await auth(b);await storage.upload(b,a.timestamp,a.signature);
 const otherContext={...context,bidder:other.address.toLowerCase()},timestamp=Date.now().toString();
 const signature=await other.signMessage(storageMessage('download',otherContext,a.contentId,timestamp));
 await assert.rejects(storage.retrieve(a.contentId,otherContext,timestamp,signature),{code:'NOT_OWNER'});
}));
test('Hash tampering after authorization fails without a write',async()=>fixture(async({storage})=>{const b=await bundle(),a=await auth(b);b.parts[0].evidence.commitment='0x'+'4'.repeat(64);await assert.rejects(storage.upload(b,a.timestamp,a.signature),{code:'INVALID_SIGNATURE'});}));
test('Wrong chain, stale version, closed tender and mismatched keys fail',async()=>fixture(async({storage,chain})=>{
 const b=await bundle(),a=await auth(b),original=chain.bidAccess;
 for(const [patch,code] of [[{version:'1'},'STALE_VERSION'],[{state:1},'SUBMISSIONS_CLOSED'],[{paused:true},'SUBMISSIONS_CLOSED'],[{deadline:'1'},'SUBMISSIONS_CLOSED'],[{requiresTechnicalOffer:true},'PARTS_MISMATCH'],[{fingerprints:['0x'+'1'.repeat(64),'',fingerprint]},'KEY_MISMATCH']] as const){chain.bidAccess=async(...args)=>({...await original(...args),...patch});await assert.rejects(storage.upload(b,a.timestamp,a.signature),{code});}
 chain.bidAccess=original;const status=chain.status;chain.status=async()=>({...await status(),chainId:'1'});await assert.rejects(storage.upload(b,a.timestamp,a.signature),{code:'DEPLOYMENT_MISMATCH'});
}));
test('Storage quota rejects new objects',async()=>fixture(async({chain,root,keys})=>{const storage=new EncryptedStorage(chain,join(root,'tiny'),keys,1),b=await bundle(),a=await auth(b);await assert.rejects(storage.upload(b,a.timestamp,a.signature),{code:'STORAGE_FULL'});}));
test('HTTP endpoints require signed JSON and never expose static ciphertext or private files',async()=>fixture(async({storage,chain})=>{
 const reader={...chain,tender:async()=>{throw new Error('unused');}},app=createApp(reader,storage),b=await bundle(),a=await auth(b);
 const send=(url:string,body?:unknown,headers={})=>inject(app,{method:'POST',url,body,headers});
 assert.equal((await send('/api/storage/bids',b)).statusCode,401);
 const response=await send('/api/storage/bids',b,{'x-storage-timestamp':a.timestamp,'x-storage-signature':a.signature});assert.equal(response.statusCode,201,response.payload);
 const r=await auth(b,'download');const read=await send(`/api/storage/${a.contentId}/retrieve`,b.context,{'x-storage-timestamp':r.timestamp,'x-storage-signature':r.signature});assert.equal(read.statusCode,200,read.payload);
 assert.equal((await inject(app,{url:`/storage/${a.contentId}.json`})).statusCode,404);
 assert.equal((await inject(app,{url:'/api/opening-keys/../../private.pem'})).statusCode,404);
 assert.equal((await send('/api/storage/bids','{bad json')).statusCode,400);
 assert.equal((await send('/api/storage/bids',b,{'content-type':'text/plain'})).statusCode,415);
 const key=await inject(app,{url:'/api/opening-keys/'+fingerprint});assert.equal(key.statusCode,200);assert.deepEqual(Object.keys(JSON.parse(key.payload)),['fingerprint','spki']);
}));

test('Development key helper separates private custody files from public API keys',async()=>{
 const root=await mkdtemp(join(tmpdir(),'constructblock-key-helper-')),cwd=join(root,'backend');await mkdir(cwd);
 try{
  execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/generate-opening-keys.mjs',import.meta.url))],{cwd,stdio:'pipe'});
  const names=await readdir(join(cwd,'opening-keys'));assert.equal(names.length,3);
  for(const name of names){const value=JSON.parse(await readFile(join(cwd,'opening-keys',name),'utf8'));assert.equal(await sha(unbase64(value.spki)),value.fingerprint);assert.deepEqual(Object.keys(value),['fingerprint','spki']);}
  const groups=await readdir(join(root,'.constructblock-custody'));assert.equal(groups.length,1);assert.equal((await readdir(join(root,'.constructblock-custody',groups[0]))).length,3);
 }finally{await rm(root,{recursive:true,force:true});}
});
