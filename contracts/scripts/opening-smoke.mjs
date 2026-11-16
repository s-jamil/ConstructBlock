import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import hre from 'hardhat';
import {BlockchainService} from '../../backend/dist/blockchain.js';
import {EncryptedStorage} from '../../backend/dist/storage.js';
import {createApp} from '../../backend/dist/app.js';
import {openingMessage} from '../../backend/dist/opening-protocol.js';
import {loadOpeningKey,processOpening} from '../../backend/dist/opening-worker.js';
import {PROTOCOL,encryptPart,sha,base64,bytes,canonicalBundle,storageMessage,unbase64,frame,contextBytes} from '../../backend/dist/bid-protocol.js';
import {inject} from '../../backend/test/inject.mjs';
const connection=await hre.network.create(),{ethers}=connection;
const [government,officer,commission,,,service,approver,bidder,outsider]=await ethers.getSigners();
const root=await mkdtemp(join(tmpdir(),'constructblock-opening-')),keyRoot=join(root,'public'),custody=join(root,'custody'),objects=join(root,'objects');
await mkdir(keyRoot);await mkdir(custody);
const pairs=[0,1,2].map(()=>generateKeyPairSync('rsa',{modulusLength:3072})),fingerprints=[];
for(const [part,pair] of pairs.entries()){
 const der=new Uint8Array(pair.publicKey.export({type:'spki',format:'der'})),fingerprint=await sha(der);fingerprints.push(fingerprint);
 await writeFile(join(keyRoot,fingerprint+'.json'),JSON.stringify({fingerprint,spki:base64(der)}));
 await writeFile(join(custody,['initial','technical','financial'][part]+'.pem'),pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
}
const registry=await ethers.deployContract('RoleRegistry',[government.address,86400]);await registry.waitForDeployment();
for(const [role,actor]of [['OFFICER_ROLE',officer],['COMMISSION_ROLE',commission],['OPENING_SERVICE_ROLE',service],['APPROVAL_ROLE',approver]])await (await registry.grantRole(ethers.id(role),actor.address)).wait();
await(await registry.approveBidder(bidder.address)).wait();
const workflow=await ethers.deployContract('ProcurementWorkflow',[await registry.getAddress()]);await workflow.waitForDeployment();
const provider=new ethers.BrowserProvider(connection.provider,undefined,{cacheTimeout:-1});
const config={port:3001,rpcUrl:'http://127.0.0.1:8545',chainId:31337n,rpcTimeoutMs:5000,registryAddress:await registry.getAddress(),workflowAddress:await workflow.getAddress()};
const chain=new BlockchainService(config,provider),storage=new EncryptedStorage(chain,objects,keyRoot),app=createApp(chain,storage),checks=[];
const deadline=(await ethers.provider.getBlock('latest')).timestamp+3600;
function request(tender='1',part=0,version='1',actor=service){return {context:{chainId:'31337',workflow:config.workflowAddress.toLowerCase(),tenderId:tender,bidder:bidder.address.toLowerCase(),version},part,service:actor.address.toLowerCase(),timestamp:Date.now().toString()};}
async function retrieve(r,signature){const response=await inject(app,{method:'POST',url:'/api/storage/openings/retrieve',body:r,headers:{'x-opening-signature':signature}});if(response.statusCode!==200){const e=JSON.parse(response.payload).error;throw Object.assign(new Error(e.message),{code:e.code,status:response.statusCode});}return JSON.parse(response.payload);}
let keyReads=0;
const worker=(r,extra={})=>processOpening({chain,signer:service,request:r,retrieve,loadKey:async(part,f)=>{keyReads++;return loadOpeningKey(custody,part,f);},...extra});
async function check(label,fn){await fn();checks.push(label);console.log('PASS '+label);}
async function makeTender(id,mutate){
 await(await workflow.connect(officer).publishTender(ethers.id('dossier '+id),deadline,true,commission.address,fingerprints)).wait();
 const context=request(String(id)).context,parts=[];
 for(const part of [0,1,2])parts.push(await encryptPart(context,part,{name:'private-'+part+'.txt',type:'text/plain',data:bytes('secret offer '+part)},new Uint8Array(pairs[part].publicKey.export({type:'spki',format:'der'})),fingerprints[part]));
 const bundle={protocol:PROTOCOL,context,parts};await mutate?.(bundle);
 const contentId=await sha(bytes(canonicalBundle(bundle))),timestamp=Date.now().toString();
 await storage.upload(bundle,timestamp,await bidder.signMessage(storageMessage('upload',context,contentId,timestamp)));
 await(await workflow.connect(bidder).submitBid(id,1,...parts.map(p=>p.evidence))).wait();return {bundle,contentId};
}
try{
 const first=await makeTender(1);
 const badCommit=await makeTender(2,b=>{b.parts[0].evidence.commitment=ethers.id('wrong plaintext commitment');});
 const badTag=await makeTender(3,async b=>{const p=b.parts[0],data=unbase64(p.ciphertext);data[data.length-1]^=1;p.ciphertext=base64(data);p.evidence.ciphertextHash=await sha(frame(contextBytes(b.context,0),unbase64(p.nonce),data));});
 await check('Unsigned, forged and expired service requests are rejected',async()=>{
  const r=request();await assert.rejects(retrieve(r,''),{code:'INVALID_SIGNATURE'});
  await assert.rejects(retrieve(r,await outsider.signMessage(openingMessage(r))),{code:'INVALID_SIGNATURE'});
  const old={...r,timestamp:String(Date.now()-360000)};await assert.rejects(retrieve(old,await service.signMessage(openingMessage(old))),{code:'EXPIRED_AUTHORIZATION'});
 });
 await check('No private key is read before deadline or commission authorization',async()=>{await assert.rejects(worker(request()),{code:'OPENING_NOT_AUTHORIZED'});assert.equal(keyReads,0);});
 await connection.provider.request({method:'evm_setNextBlockTimestamp',params:[deadline]});
 for(const id of [1,2,3])await(await workflow.connect(commission).closeTender(id)).wait();
 await check('Closure alone cannot release a part; only the assigned commission can authorize opening',async()=>{
  await assert.rejects(worker(request()),{code:'OPENING_NOT_AUTHORIZED'});assert.equal(keyReads,0);
  await assert.rejects(workflow.connect(outsider).requestOpening(1,0));
 });
 for(const id of [1,2,3])await(await workflow.connect(commission).requestOpening(id,0)).wait();
 await check('An authorized endpoint returns only the approved part, not unopened technical or financial material',async()=>{
  const r=request(),value=await retrieve(r,await service.signMessage(openingMessage(r)));assert.equal(value.part.part,0);assert.equal('parts'in value,false);
  assert.ok(!JSON.stringify(value).includes(first.bundle.parts[2].wrapped));assert.ok(!JSON.stringify(value).includes('private-'));
  const changed={...r,part:2};await assert.rejects(retrieve(changed,await service.signMessage(openingMessage(r))),{code:'INVALID_SIGNATURE'});
  await assert.rejects(worker(request('1',2)),{code:'OPENING_NOT_AUTHORIZED'});
 });
 await check('Wrong service, wrong deployment, stale version and paused platform are rejected',async()=>{
  const r=request('1',0,'1',outsider);await assert.rejects(retrieve(r,await outsider.signMessage(openingMessage(r))),{code:'NOT_OPENING_SERVICE'});
  const wrong=request();wrong.context.workflow=outsider.address.toLowerCase();await assert.rejects(retrieve(wrong,await service.signMessage(openingMessage(wrong))),{code:'DEPLOYMENT_MISMATCH'});
  await assert.rejects(worker(request('1',0,'2')),{code:'BID_NOT_OPENABLE'});
  await(await workflow.setPaused(true)).wait();await assert.rejects(worker(request()),{code:'OPENING_NOT_AUTHORIZED'});await(await workflow.setPaused(false)).wait();
 });
 await check('Service revocation between retrieval and key access prevents key loading',async()=>{
  const count=keyReads;
  await assert.rejects(worker(request(),{retrieve:async(r,signature)=>{
    const selected=await retrieve(r,signature);
    await(await registry.revokeRole(ethers.id('OPENING_SERVICE_ROLE'),service.address)).wait();return selected;
  }}),{code:'NOT_OPENING_SERVICE'});
  assert.equal(keyReads,count);await(await registry.grantRole(ethers.id('OPENING_SERVICE_ROLE'),service.address)).wait();
 });
 await check('Missing objects and wrong operator keys leave on-chain outcomes pending',async()=>{
  const path=join(objects,first.contentId+'.json'),saved=await readFile(path);await writeFile(path,'{}');
  await assert.rejects(worker(request()),{code:'OPENING_PACKAGE_MISSING'});await writeFile(path,saved);
  await assert.rejects(worker(request(),{loadKey:()=>loadOpeningKey(custody,2,fingerprints[0])}),{code:'CUSTODY_KEY_UNAVAILABLE'});
  assert.equal(await workflow.getOutcome(1,bidder.address,0),0n);
 });
 let report;
 await check('Initial stage decrypts and verifies commitment, records a matching receipt and prevents reprocessing',async()=>{
  report=await worker(request());assert.equal(report.status,'confirmed');assert.equal(report.verified,true);assert.equal(await workflow.getOutcome(1,bidder.address,0),1n);
  assert.ok(!JSON.stringify(report).includes('secret offer'));assert.ok(!JSON.stringify(report).includes('private-'));
  const reads=keyReads;await assert.rejects(worker(request()),{code:'BID_NOT_OPENABLE'});assert.equal(keyReads,reads);
 });
 await check('On-chain commitment mismatch records Failed with a non-sensitive attestation digest',async()=>{
  const result=await worker(request('2'));assert.equal(result.verified,false);assert.equal(result.code,'COMMITMENT_MISMATCH');assert.equal(await workflow.getOutcome(2,bidder.address,0),2n);
 });
 await check('On-chain authenticated ciphertext with an invalid tag records Failed',async()=>{
  const result=await worker(request('3'));assert.equal(result.verified,false);assert.equal(result.code,'AUTHENTICATION_FAILED');assert.equal(await workflow.getOutcome(3,bidder.address,0),2n);
 });
 await check('Technical stage is authorized separately and records verified evidence',async()=>{
  await(await workflow.connect(commission).recordAdmission(1,bidder.address,true,ethers.id('admit'))).wait();
  await assert.rejects(worker(request('1',1)),{code:'OPENING_NOT_AUTHORIZED'});
  await(await workflow.connect(commission).requestOpening(1,1)).wait();const result=await worker(request('1',1));assert.equal(result.verified,true);
 });
 await check('Financial stage requires technical acceptance and commission authorization',async()=>{
  await assert.rejects(workflow.connect(commission).requestOpening(1,2));
  await(await workflow.connect(commission).recordTechnicalDecision(1,bidder.address,true,ethers.id('technical accepted'))).wait();
  await(await workflow.connect(commission).requestOpening(1,2)).wait();
  const result=await worker(request('1',2));assert.equal(result.verified,true);assert.equal(await workflow.getOutcome(1,bidder.address,2),1n);
 });
 await check('Service revocation blocks further opening retrieval',async()=>{
  await(await registry.revokeRole(ethers.id('OPENING_SERVICE_ROLE'),service.address)).wait();const r=request();await assert.rejects(retrieve(r,await service.signMessage(openingMessage(r))),{code:'NOT_OPENING_SERVICE'});
 });
 await mkdir('reports',{recursive:true});await writeFile('reports/opening-smoke.json',JSON.stringify({project:'constructBlock',generatedAt:new Date().toISOString(),result:'passed',checks,execution:'Real isolated Hardhat EVM, signed injected HTTP retrieval, persisted encrypted objects and operator worker with temporary custody files',limitations:['Local software access gate, not threshold cryptography or HSM custody','No real browser wallet or OS TCP listener','Worker verifies in memory without returning plaintext to the API or a commission UI']},null,2)+'\n');
}finally{provider.destroy();await connection.close();await rm(root,{recursive:true,force:true});}
