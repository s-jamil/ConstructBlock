import {DocumentService} from '../../backend/dist/document-service.js';
import {createDocumentApp} from '../../backend/dist/document-app.js';
import {documentMessage} from '../../backend/dist/document-protocol.js';
import {viewDocument} from '../../frontend/src/document-client.ts';
import {loadGovernance} from '../../frontend/src/governance-client.ts';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import hre from 'hardhat';
import {BlockchainService} from '../../backend/dist/blockchain.js';
import {EncryptedStorage} from '../../backend/dist/storage.js';
import {openOrbitRuntime} from '../../backend/dist/orbitdb-runtime.js';
import {OrbitDbCiphertextStore} from '../../backend/dist/orbitdb-store.js';
import {OrbitDbClient} from '../../backend/dist/orbitdb-client.js';
import {serveOrbitStorage} from '../../backend/dist/orbitdb-server.js';
import {createApp} from '../../backend/dist/app.js';
import {openingMessage} from '../../backend/dist/opening-protocol.js';
import {loadOpeningKey,processOpening} from '../../backend/dist/opening-worker.js';
import {PROTOCOL,encryptPart,sha,base64,bytes,canonicalBundle,storageMessage,unbase64,frame,contextBytes} from '../../backend/dist/bid-protocol.js';
import {inject} from '../../backend/test/inject.mjs';
const storageMode=process.env.CONSTRUCTBLOCK_TEST_STORAGE??'filesystem';
if(!['filesystem','orbitdb-direct','orbitdb-socket'].includes(storageMode))throw new Error('Invalid test storage mode.');
const connection=await hre.network.create(),{ethers}=connection;
const [government,officer,commission,unassigned1,unassigned2,service,approver,bidder,outsider]=await ethers.getSigners();
const root=await mkdtemp(storageMode==='filesystem'?join(tmpdir(),'constructblock-opening-'):'/tmp/cb-workflow-'),keyRoot=join(root,'public'),custody=join(root,'custody'),objects=join(root,'objects');
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
let runtime,owner,store,viewerStore;
const checks=[];
if(storageMode!=='filesystem'){
 try{
  runtime=await openOrbitRuntime(join(root,'orbitdb'));
  store=new OrbitDbCiphertextStore(runtime.database);
  assert.equal(runtime.database.peers.size,0);
  if(storageMode==='orbitdb-socket'){
   const socket=join(root,'storage.sock');
   owner=await serveOrbitStorage(store,socket,{provider:'orbitdb',address:runtime.address,sync:false});
   store=new OrbitDbClient(socket);viewerStore=new OrbitDbClient(socket,true);
   assert.equal((await store.info()).address,runtime.address);
  }else viewerStore=new OrbitDbCiphertextStore(runtime.database);
 }catch(e){await owner?.close();await runtime?.close();provider.destroy();await connection.close();await rm(root,{recursive:true,force:true});throw e;}
}
const chain=new BlockchainService(config,provider),storage=new EncryptedStorage(chain,objects,keyRoot,undefined,store),app=createApp(chain,storage);
const viewerStorage=new EncryptedStorage(chain,objects,keyRoot,undefined,viewerStore);
const deadline=(await ethers.provider.getBlock('latest')).timestamp+3600;
function request(tender='1',part=0,version='1',actor=service){return {context:{chainId:'31337',workflow:config.workflowAddress.toLowerCase(),tenderId:tender,bidder:bidder.address.toLowerCase(),version},part,service:actor.address.toLowerCase(),timestamp:Date.now().toString()};}
async function retrieve(r,signature){const response=await inject(app,{method:'POST',url:'/api/storage/openings/retrieve',body:r,headers:{'x-opening-signature':signature}});if(response.statusCode!==200){const e=JSON.parse(response.payload).error;throw Object.assign(new Error(e.message),{code:e.code,status:response.statusCode});}return JSON.parse(response.payload);}
let keyReads=0;
const worker=(r,extra={})=>processOpening({chain,signer:service,request:r,retrieve,loadKey:async(part,f)=>{keyReads++;return loadOpeningKey(custody,part,f);},...extra});
async function check(label,fn){documentApp=createDocumentApp(documentService,'http://127.0.0.1:5173');await fn();checks.push(label);console.log('PASS '+label);}
async function makeTender(id,mutate){
 await(await workflow.connect(officer).publishTender(ethers.id('dossier '+id),deadline,true,commission.address,fingerprints)).wait();
 const context=request(String(id)).context,parts=[];
 for(const part of [0,1,2])parts.push(await encryptPart(context,part,{name:'private-'+part+'.txt',type:'text/plain',data:bytes('secret offer '+part)},new Uint8Array(pairs[part].publicKey.export({type:'spki',format:'der'})),fingerprints[part]));
 const bundle={protocol:PROTOCOL,context,parts};await mutate?.(bundle);
 const contentId=await sha(bytes(canonicalBundle(bundle))),timestamp=Date.now().toString();
 const uploaded=await inject(app,{method:'POST',url:'/api/storage/bids',body:bundle,headers:{'x-storage-timestamp':timestamp,'x-storage-signature':await bidder.signMessage(storageMessage('upload',context,contentId,timestamp))}});
 assert.equal(uploaded.statusCode,201,uploaded.payload);assert.equal(JSON.parse(uploaded.payload).contentId,contentId);
 await(await workflow.connect(bidder).submitBid(id,1,...parts.map(p=>p.evidence))).wait();return {bundle,contentId};
}
const documentService=new DocumentService(chain,viewerStorage,async(part,f)=>{keyReads++;return loadOpeningKey(custody,part,f);},join(root,'audit'));
let documentApp=createDocumentApp(documentService,'http://127.0.0.1:5173');
function viewRequest(part=0,actor=commission,version='1',tender='1'){return {context:request(tender,part,version).context,part,viewer:actor.address.toLowerCase(),timestamp:Date.now().toString(),nonce:'0x'+crypto.randomUUID().replaceAll('-','')};}
async function view(r,actor=commission,signature){
 const response=await inject(documentApp,{method:'POST',url:'/api/documents/view',body:r,headers:{origin:'http://127.0.0.1:5173','x-document-signature':signature??await actor.signMessage(documentMessage(r))}});
 if(response.statusCode!==200){const e=JSON.parse(response.payload).error;throw Object.assign(new Error(e.message),{code:e.code});}return JSON.parse(response.payload);
}
function wallet(actor){return {request:async({method,params})=>{
 if(method==='eth_accounts'||method==='eth_requestAccounts')return [actor.address];
 if(method==='personal_sign'){assert.equal(params[1].toLowerCase(),actor.address.toLowerCase());return actor.signMessage(ethers.getBytes(params[0]));}
 return connection.provider.request({method,params:params??[]});
}};}
const deployment={ready:true,chainId:'31337',expectedChainId:'31337',blockNumber:0,contracts:{roleRegistry:config.registryAddress,procurementWorkflow:config.workflowAddress,registryLinked:true}};
try{
 const first=await makeTender(1),failed=await makeTender(2,b=>{b.parts[0].evidence.commitment=ethers.id('invalid commitment');});
 await makeTender(3);
 await check('Before deadline or commission authorization the viewer cannot load private keys',async()=>{await assert.rejects(view(viewRequest()),{code:'DOCUMENT_STAGE_LOCKED'});assert.equal(keyReads,0);});
 await check('Government, bidder, unassigned actor, final approver and unrelated wallets have no implicit document access',async()=>{
  for(const actor of [government,bidder,unassigned1,approver,outsider])await assert.rejects(view(viewRequest(0,actor),actor),{code:'NOT_DOCUMENT_REVIEWER'});assert.equal(keyReads,0);
 });
 await check('Wrong deployment, unsigned requests and substituted signed targets are denied',async()=>{
  const r=viewRequest(),signature=await commission.signMessage(documentMessage(r));await assert.rejects(view(r,commission,''),{code:'INVALID_SIGNATURE'});
  await assert.rejects(view({...r,part:2},commission,signature),{code:'INVALID_SIGNATURE'});
  const wrong=viewRequest();wrong.context.chainId='1';await assert.rejects(view(wrong),{code:'DEPLOYMENT_MISMATCH'});
 });
 await connection.provider.request({method:'evm_setNextBlockTimestamp',params:[deadline]});
 for(const id of [1,2,3])await(await workflow.connect(commission).closeTender(id)).wait();
 await check('Closure alone cannot enable document viewing',async()=>{await assert.rejects(view(viewRequest()),{code:'DOCUMENT_STAGE_LOCKED'});assert.equal(keyReads,0);});
 for(const id of [1,2,3])await(await workflow.connect(commission).requestOpening(id,0)).wait();
 await check('Commission authorization does not release a Pending document',async()=>{await assert.rejects(view(viewRequest()),{code:'DOCUMENT_NOT_VERIFIED'});assert.equal(keyReads,0);});
 await worker(request());await worker(request('2'));
 await check('Verified initial contents are returned only to the commission with a persisted audit and nonce replay prevention',async()=>{
  const r=viewRequest(),signature=await commission.signMessage(documentMessage(r)),value=await view(r,commission,signature);
  assert.equal(Buffer.from(unbase64(value.document.data)).toString(),'secret offer 0');assert.equal('parts'in value,false);
  await assert.rejects(view(r,commission,signature),{code:'DOCUMENT_REQUEST_REPLAYED'});
  const audit=(await Promise.all((await readdir(join(root,'audit'))).map(n=>readFile(join(root,'audit',n),'utf8')))).join('\n');assert.match(audit,/release-authorized/);assert.ok(!audit.includes('secret offer')&&!audit.includes('private-')&&!audit.includes(signature));
 });
 await check('Failed parts, stale versions and unopened financial offers remain restricted',async()=>{
  await assert.rejects(view(viewRequest(0,commission,'1','2')),{code:'DOCUMENT_NOT_VERIFIED'});
  await assert.rejects(view(viewRequest(0,commission,'2')),{code:'DOCUMENT_NOT_VERIFIED'});
  await assert.rejects(view(viewRequest(2)),{code:'DOCUMENT_STAGE_LOCKED'});
 });
 await check('The actual browser client signs, requests and validates a matching verified document',async()=>{
  const w=wallet(commission),snapshot=await loadGovernance(w,deployment,'1');
  const result=await viewDocument(w,snapshot,bidder.address,'1',0,()=>true,new AbortController().signal,async(url,options)=>{
   assert.equal(url,'/api/documents/view');const response=await inject(documentApp,{method:'POST',url,body:JSON.parse(options.body),headers:{origin:'http://127.0.0.1:5173','x-document-signature':options.headers['X-Document-Signature']}});
   return new Response(response.payload,{status:response.statusCode,headers:response.headers});
  });assert.equal(new TextDecoder().decode(result.data),'secret offer 0');result.data.fill(0);
 });
 await check('Paused platform and revoked commission role block later releases',async()=>{
  await(await workflow.setPaused(true)).wait();await assert.rejects(view(viewRequest()),{code:'DOCUMENT_STAGE_LOCKED'});await(await workflow.setPaused(false)).wait();
  await(await registry.revokeRole(ethers.id('COMMISSION_ROLE'),commission.address)).wait();await assert.rejects(view(viewRequest()),{code:'NOT_DOCUMENT_REVIEWER'});await(await registry.grantRole(ethers.id('COMMISSION_ROLE'),commission.address)).wait();
 });
 await check('Revocation during key loading is rechecked after decryption before release',async()=>{
  const original=documentService.loadKey;documentService.loadKey=async(part,f)=>{const key=await original(part,f);await(await registry.revokeRole(ethers.id('COMMISSION_ROLE'),commission.address)).wait();return key;};
  await assert.rejects(view(viewRequest()),{code:'NOT_DOCUMENT_REVIEWER'});documentService.loadKey=original;await(await registry.grantRole(ethers.id('COMMISSION_ROLE'),commission.address)).wait();
 });
 await check('Missing or corrupted stored ciphertext fails closed without changing verification outcomes',async()=>{
  if(runtime){
   const key=first.contentId+':0',saved=(await runtime.database.get(key)).value;
   try{await runtime.database.put({...saved,part:{}});await assert.rejects(view(viewRequest()),{code:'OPENING_PACKAGE_MISSING'});}
   finally{await runtime.database.put(saved);}
  }else{
   const path=join(objects,first.contentId+'.json'),saved=await readFile(path);
   try{await writeFile(path,'{}');await assert.rejects(view(viewRequest()),{code:'OPENING_PACKAGE_MISSING'});}finally{await writeFile(path,saved);}
  }
  assert.equal(await workflow.getOutcome(1,bidder.address,0),1n);
 });
 await check('Technical and financial documents require their own verified opening stages',async()=>{
  await(await workflow.connect(commission).recordAdmission(1,bidder.address,true,ethers.id('admit'))).wait();
  for(const part of [1,2]){
   if(part===2)await(await workflow.connect(commission).recordTechnicalDecision(1,bidder.address,true,ethers.id('accept'))).wait();
   await(await workflow.connect(commission).requestOpening(1,part)).wait();
   await assert.rejects(view(viewRequest(part)),{code:'DOCUMENT_NOT_VERIFIED'});await worker(request('1',part));
   const value=await view(viewRequest(part));assert.equal(Buffer.from(unbase64(value.document.data)).toString(),'secret offer '+part);
  }
 });
 await check('Verified documents remain accessible through selection and approval; cancellation stops access',async()=>{
  await(await workflow.connect(commission).selectBidder(1,bidder.address,ethers.id('selection'))).wait();await view(viewRequest(2));
  await(await workflow.connect(approver).decideFinalApproval(1,true,ethers.id('approval'))).wait();await view(viewRequest(2));
  await worker(request('3'));await(await workflow.cancelTender(3,ethers.id('cancel'))).wait();await assert.rejects(view(viewRequest(0,commission,'1','3')),{code:'DOCUMENT_STAGE_LOCKED'});
 });
 await check('The public API never exposes a plaintext viewing endpoint or document content',async()=>{
  const r=viewRequest(),response=await inject(app,{method:'POST',url:'/api/documents/view',body:r});assert.notEqual(response.statusCode,200);
  const publicTender=await inject(app,{url:'/api/tenders/1'});assert.ok(!publicTender.payload.includes('secret offer')&&!publicTender.payload.includes('document'));
 });
 if(runtime){
  await check('OrbitDB contains exact encrypted packages and the tender reaches Approved',async()=>{
   assert.equal(await store.get(first.contentId),canonicalBundle(first.bundle));
   assert.equal((await store.ids()).length,3);
   const response=await inject(app,{url:'/api/tenders/1'});assert.equal(response.statusCode,200);assert.equal(JSON.parse(response.payload).state,'Approved');
   assert.equal(runtime.database.peers.size,0);
  });
 }
 await mkdir('reports',{recursive:true});await writeFile(storageMode==='filesystem'?'reports/document-smoke.json':'reports/'+storageMode+'-workflow.json',JSON.stringify({project:'constructBlock',generatedAt:new Date().toISOString(),result:'passed',storageMode,checks,execution:'Actual browser document client, isolated real Hardhat EVM, signed HTTP handler, genuine RSA/AES documents and persisted audit',limitations:[...(storageMode==='orbitdb-direct'?['Direct OrbitDB adapter; Unix socket transport is not exercised']:[]),'No real browser extension prompts or live TCP listener','Local file custody; Vault protocol adapter has separate simulated-transport tests','Audits record release authorization, not proof the recipient read the file','Authorization cannot revoke previously released copies']},null,2)+'\n');
}finally{await owner?.close();await runtime?.close();provider.destroy();await connection.close();await rm(root,{recursive:true,force:true});}
