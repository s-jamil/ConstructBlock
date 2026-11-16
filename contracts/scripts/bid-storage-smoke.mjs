import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync,privateDecrypt,createDecipheriv,constants} from 'node:crypto';
import hre from 'hardhat';
import {BlockchainService} from '../../backend/dist/blockchain.js';
import {EncryptedStorage} from '../../backend/dist/storage.js';
import {createApp} from '../../backend/dist/app.js';
import {inject} from '../../backend/test/inject.mjs';
import {loadBidSession,openingKey,uploadBid,submitEncryptedBid,confirmBid,retrieveBid} from '../../frontend/src/bid-client.ts';
import {PROTOCOL,encryptPart,sha,base64,bytes,contextBytes,frame,unbase64,canonicalBundle} from '../../backend/src/bid-protocol.ts';
const connection=await hre.network.create(),{ethers}=connection;
const [government,officer,commission,bidder,outsider]=await ethers.getSigners();
const root=await mkdtemp(join(tmpdir(),'constructblock-bid-evm-')),keys=join(root,'keys'),objects=join(root,'objects');
await mkdir(keys);
const pair=generateKeyPairSync('rsa',{modulusLength:3072}),der=new Uint8Array(pair.publicKey.export({type:'spki',format:'der'})),fingerprint=await sha(der);
await writeFile(join(keys,fingerprint+'.json'),JSON.stringify({fingerprint,spki:base64(der)}));
const registry=await ethers.deployContract('RoleRegistry',[government.address,86400]);await registry.waitForDeployment();
await (await registry.grantRole(await registry.OFFICER_ROLE(),officer.address)).wait();
await (await registry.grantRole(await registry.COMMISSION_ROLE(),commission.address)).wait();
await (await registry.approveBidder(bidder.address)).wait();
const workflow=await ethers.deployContract('ProcurementWorkflow',[await registry.getAddress()]);await workflow.waitForDeployment();
const provider=new ethers.BrowserProvider(connection.provider,undefined,{cacheTimeout:-1});
const config={port:3001,rpcUrl:'http://127.0.0.1:8545',chainId:31337n,rpcTimeoutMs:5000,registryAddress:await registry.getAddress(),workflowAddress:await workflow.getAddress()};
const service=new BlockchainService(config,provider);
let storage=new EncryptedStorage(service,objects,keys),app=createApp(service,storage),sends=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(path,options={})=>{
 const response=await inject(app,{method:options.method??'GET',url:String(path),body:options.body,headers:Object.fromEntries(Object.entries(options.headers??{}).map(([k,v])=>[k.toLowerCase(),v]))});
 return new Response(response.payload,{status:response.statusCode,headers:response.headers});
};
function wallet(signer,chain){return {request:async({method,params})=>{
 if(method==='eth_accounts'||method==='eth_requestAccounts')return [signer.address];
 if(method==='eth_chainId'&&chain)return chain;
 if(method==='personal_sign'){assert.equal(params[1].toLowerCase(),signer.address.toLowerCase());return signer.signMessage(ethers.getBytes(params[0]));}
 if(method==='eth_sendTransaction'){assert.equal(params[0].from.toLowerCase(),signer.address.toLowerCase());sends++;}
 return connection.provider.request({method,params:params??[]});
}};}
const w=wallet(bidder),checks=[];
async function check(label,fn){await fn();checks.push(label);console.log('PASS '+label);}
try{
 const deployment=await service.status(),deadline=(await ethers.provider.getBlock('latest')).timestamp+3600;
 await (await workflow.connect(officer).publishTender(ethers.id('dossier'),deadline,true,commission.address,[fingerprint,fingerprint,fingerprint])).wait();
 await check('Wrong network and unapproved bidder rejected before encryption or signing',async()=>{
  await assert.rejects(loadBidSession(wallet(bidder,'0x1'),deployment,'1'),/chain/);
  await assert.rejects(loadBidSession(wallet(outsider),deployment,'1'),/BIDDER_ROLE/);
 });
 const session=await loadBidSession(w,deployment,'1');assert.equal(session.context.version,'1');assert.equal(session.requiresTechnicalOffer,true);
 const parts=[];
 for(const part of [0,1,2])parts.push(await encryptPart(session.context,part,{name:`secret-${part}.txt`,type:'text/plain',data:bytes(`confidential amount ${part}`)},await openingKey(session.fingerprints[part]),fingerprint));
 const bundle={protocol:PROTOCOL,context:session.context,parts};let contentId;
 await check('Browser encrypts required parts, authenticates upload and receives a non-acceptance storage receipt',async()=>{
  contentId=await uploadBid(w,session,bundle);assert.equal(contentId,await sha(bytes(canonicalBundle(bundle))));assert.equal(sends,0);
  assert.equal((await workflow.getBid(1,bidder.address)).version,0n);
  assert.ok(!(await readFile(join(objects,contentId+'.json'),'utf8')).includes('secret-'));
 });
 await check('Upload retry is idempotent and survives storage service restart',async()=>{
  assert.equal(await uploadBid(w,session,bundle),contentId);assert.equal((await readdir(objects)).length,1);
  storage=new EncryptedStorage(service,objects,keys);app=createApp(service,storage);
  assert.deepEqual(await retrieveBid(w,deployment,bundle,contentId),bundle);
 });
 await check('Wrong stored content ID and invalidated session prevent signing',async()=>{
  await assert.rejects(submitEncryptedBid(w,session,bundle,ethers.id('wrong')),/differs/);
  await assert.rejects(submitEncryptedBid(w,session,bundle,contentId,()=>false),/changed/);assert.equal(sends,0);
 });
 let tx;
 await check('Bidder signs one transaction and matching BidSubmitted evidence is confirmed',async()=>{
  tx=await submitEncryptedBid(w,session,bundle,contentId);assert.equal(sends,1);
  const receipt=await confirmBid(w,tx);assert.ok(receipt);assert.equal((await workflow.getBid(1,bidder.address)).version,1n);
  for(const part of bundle.parts){const evidence=await workflow.getEvidence(1,bidder.address,1,part.part);assert.equal(evidence.ciphertextHash,part.evidence.ciphertextHash);assert.equal(evidence.wrappedPackageHash,part.evidence.wrappedPackageHash);}
  const altered={...tx,evidence:tx.evidence.map(e=>({...e,commitment:ethers.id('not submitted')}))};await assert.rejects(confirmBid(w,altered),/expected bid evidence/);
 });
 await check('Original upload cannot be resubmitted as the next version',async()=>{
  await assert.rejects(submitEncryptedBid(w,session,bundle,contentId),/version/);
  await assert.rejects(uploadBid(w,session,bundle),/version/);assert.equal(sends,1);
  assert.equal((await loadBidSession(w,deployment,'1')).context.version,'2');
 });
 await check('Stored ciphertext can be independently decrypted and matched to the on-chain commitment',async()=>{
  const part=(await retrieveBid(w,deployment,bundle,contentId)).parts[0];
  const material=privateDecrypt({key:pair.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},unbase64(part.wrapped));
  const encrypted=Buffer.from(unbase64(part.ciphertext)),decipher=createDecipheriv('aes-256-gcm',material.subarray(0,32),unbase64(part.nonce));
  decipher.setAAD(contextBytes(bundle.context,0));decipher.setAuthTag(encrypted.subarray(-16));const plain=Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]);
  assert.equal(await sha(frame(contextBytes(bundle.context,0),material.subarray(32),plain)),(await workflow.getEvidence(1,bidder.address,1,0)).commitment);
  assert.equal(JSON.parse(plain).name,'secret-0.txt');
 });
 await check('Tender without technical part submits a zero technical evidence tuple',async()=>{
  await (await workflow.connect(officer).publishTender(ethers.id('second'),deadline,false,commission.address,[fingerprint,ethers.ZeroHash,fingerprint])).wait();
  const s=await loadBidSession(w,deployment,'2'),p=[];for(const part of [0,2])p.push(await encryptPart(s.context,part,{name:'part.txt',type:'text/plain',data:bytes('test')},der,fingerprint));
  const b={protocol:PROTOCOL,context:s.context,parts:p},stored=await uploadBid(w,s,b),transaction=await submitEncryptedBid(w,s,b,stored);assert.ok(await confirmBid(w,transaction));
  assert.equal((await workflow.getEvidence(2,bidder.address,1,1)).commitment,ethers.ZeroHash);
 });
 await check('Role revocation prevents retrieval and another upload',async()=>{
  await (await registry.revokeBidder(bidder.address)).wait();await assert.rejects(retrieveBid(w,deployment,bundle,contentId),/bidder role/);await assert.rejects(loadBidSession(w,deployment,'1'),/BIDDER_ROLE/);
 });
 await mkdir('reports',{recursive:true});await writeFile('reports/bid-storage-smoke.json',JSON.stringify({project:'constructBlock',generatedAt:new Date().toISOString(),result:'passed',checks,execution:'Isolated real Hardhat EVM, disposable wallet adapter, browser WebCrypto functions, injected HTTP and temporary persistent disk storage',limitations:['No real extension approval dialog or OS TCP listener','Private keys exist only in this single-process test; not production custody','Does not implement an opening-service decryption endpoint']},null,2)+'\n');
}finally{globalThis.fetch=originalFetch;provider.destroy();await connection.close();await rm(root,{recursive:true,force:true});}
