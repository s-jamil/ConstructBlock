import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import hre from 'hardhat';
import {loadGovernance,submitGovernance,confirmGovernance,actionUnavailable} from '../../frontend/src/governance-client.ts';
import {BlockchainService} from '../../backend/dist/blockchain.js';
import {createApp} from '../../backend/dist/app.js';
import {inject} from '../../backend/test/inject.mjs';
const connection=await hre.network.create(),{ethers}=connection;
const [government,officer,commission,c1,c2,service,approver,bidder,bidder2,outsider]=await ethers.getSigners();
const registry=await ethers.deployContract('RoleRegistry',[government.address,86400]);await registry.waitForDeployment();
for(const [role,actor]of [['OFFICER_ROLE',officer],['COMMISSION_ROLE',commission],['OPENING_SERVICE_ROLE',service],['APPROVAL_ROLE',approver],['APPROVAL_ROLE',commission]])await(await registry.grantRole(ethers.id(role),actor.address)).wait();
for(const b of [bidder,bidder2])await(await registry.approveBidder(b.address)).wait();
const workflow=await ethers.deployContract('ProcurementWorkflow',[await registry.getAddress()]);await workflow.waitForDeployment();
const deployment={ready:true,chainId:'31337',expectedChainId:'31337',blockNumber:0,contracts:{roleRegistry:await registry.getAddress(),procurementWorkflow:await workflow.getAddress(),registryLinked:true}};
const provider=new ethers.BrowserProvider(connection.provider,undefined,{cacheTimeout:-1});
const backend=new BlockchainService({port:3001,rpcUrl:'http://127.0.0.1:8545',chainId:31337n,rpcTimeoutMs:5000,registryAddress:deployment.contracts.roleRegistry,workflowAddress:deployment.contracts.procurementWorkflow},provider),app=createApp(backend);
const e={commitment:ethers.id('commit'),ciphertextHash:ethers.id('cipher'),wrappedPackageHash:ethers.id('package')},zero={commitment:ethers.ZeroHash,ciphertextHash:ethers.ZeroHash,wrappedPackageHash:ethers.ZeroHash};
const deadline=(await ethers.provider.getBlock('latest')).timestamp+3600;
for(let tid=1;tid<=3;tid++){
 await(await workflow.connect(officer).publishTender(ethers.id('dossier '+tid),deadline,false,commission.address,[ethers.id('initial'),ethers.ZeroHash,ethers.id('financial')])).wait();
 for(const b of [bidder,bidder2])await(await workflow.connect(b).submitBid(tid,1,e,zero,e)).wait();
}
await connection.provider.request({method:'evm_setNextBlockTimestamp',params:[deadline]});await connection.provider.request({method:'evm_mine',params:[]});
let sends=0;
function wallet(actor,chain){return {request:async({method,params})=>{if(method==='eth_accounts'||method==='eth_requestAccounts')return [actor.address];if(method==='eth_chainId'&&chain)return chain;if(method==='eth_sendTransaction'){assert.equal(params[0].from.toLowerCase(),actor.address.toLowerCase());sends++;}return connection.provider.request({method,params:params??[]});}};}
const snapshot=(actor=commission,tid='1')=>loadGovernance(wallet(actor),deployment,tid);
const selection=(address=bidder.address)=>({kind:'select',bidder:address,version:'1',reasonDigest:ethers.id('human selection record')});
const final=(s,accept=true)=>({kind:'final',accept,reasonDigest:ethers.id(accept?'approval record':'rejection record'),selectedBidder:s.selectedBidder,selectionDigest:s.selectionDigest});
const extract=(s,digest=ethers.id('public extract'))=>({kind:'extract',reasonDigest:digest,selectedBidder:s.selectedBidder,selectionDigest:s.selectionDigest,previousExtractDigest:s.publicExtractDigest});
async function act(actor,s,a){const tx=await submitGovernance(wallet(actor),s,a);assert.ok(await confirmGovernance(wallet(actor),tx));return tx;}
async function prepare(tid){
 await(await workflow.connect(commission).closeTender(tid)).wait();await(await workflow.connect(commission).requestOpening(tid,0)).wait();
 for(const b of [bidder,bidder2]){await(await workflow.connect(service).recordOpeningResult(tid,b.address,1,0,true,ethers.id('initial verified'))).wait();await(await workflow.connect(commission).recordAdmission(tid,b.address,true,ethers.id('admit'))).wait();}
 await(await workflow.connect(commission).requestOpening(tid,2)).wait();
}
const checks=[];async function check(label,fn){await fn();checks.push(label);console.log('PASS '+label);}
try{
 await check('Final approver can load the actor view; unrelated and wrong-network wallets cannot',async()=>{const s=await snapshot(approver);assert.equal(s.isApprover,true);assert.equal(s.isCommission,false);await assert.rejects(snapshot(outsider),/neither/);await assert.rejects(loadGovernance(wallet(approver,'0x1'),deployment,'1'),/chain/);});
 await check('Selection is blocked before the financial stage',async()=>{const before=sends;await assert.rejects(submitGovernance(wallet(commission),await snapshot(),selection()),/financial/);assert.equal(sends,before);});
 await prepare(1);await prepare(2);await prepare(3);
 for(const tid of [1,2,3])await(await workflow.connect(service).recordOpeningResult(tid,bidder.address,1,2,true,ethers.id('financial verified'))).wait();
 await check('All eligible financial outcomes must be recorded before selection',async()=>{await assert.rejects(submitGovernance(wallet(commission),await snapshot(),selection()),/all eligible/);});
 for(const tid of [1,2,3])await(await workflow.connect(service).recordOpeningResult(tid,bidder2.address,1,2,false,ethers.id('financial failed'))).wait();
 await check('Failed financial evidence, unapproved review versions and unassigned actor selection are rejected',async()=>{
  let s=await snapshot();await assert.rejects(submitGovernance(wallet(commission),s,selection(bidder2.address)),/verified financial/);await assert.rejects(submitGovernance(wallet(commission),s,{...selection(),version:'2'}),/not active/);
  await assert.rejects(snapshot(c1),/neither/);
 });
 await check('Commission selects a verified bidder and selection remains provisional',async()=>{
  const tx=await act(commission,await snapshot(),selection()),s=await snapshot();assert.equal(s.state,5);assert.equal(s.selectedBidder,bidder.address);assert.equal(s.selectionDigest,selection().reasonDigest);assert.equal(s.finalDecision,null);
  await assert.rejects(confirmGovernance(wallet(commission),{...tx,action:selection(bidder2.address)}),/expected workflow event/);
 });
 await check('Commission cannot self-approve even when granted APPROVAL_ROLE',async()=>{const s=await snapshot();assert.equal(s.isApprover,false);await assert.rejects(submitGovernance(wallet(commission),s,final(s)),/distinct/);});
 await check('Final approval is bound to the reviewed selection and current role',async()=>{
  const s=await snapshot(approver);await assert.rejects(submitGovernance(wallet(approver),s,{...final(s),selectionDigest:ethers.id('stale')}),/changed/);
  await(await registry.revokeRole(ethers.id('APPROVAL_ROLE'),approver.address)).wait();await assert.rejects(submitGovernance(wallet(approver),s,final(s)),/neither/);await(await registry.grantRole(ethers.id('APPROVAL_ROLE'),approver.address)).wait();
  await(await workflow.setPaused(true)).wait();await assert.rejects(submitGovernance(wallet(approver),s,final(s)),/paused/);await(await workflow.setPaused(false)).wait();
 });
 await check('Commission may record a provisional extract without approving or publishing an award',async()=>{const s=await snapshot();await act(commission,s,extract(s));const next=await snapshot();assert.equal(next.state,5);assert.equal(next.publicExtractDigest,ethers.id('public extract'));});
 await check('Separate approver records approval and cannot overwrite it',async()=>{
  const s=await snapshot(approver),tx=await act(approver,s,final(s)),next=await snapshot(approver);assert.equal(next.state,6);assert.equal(next.finalDecision.approved,true);assert.equal(next.finalDecision.actor,approver.address);assert.equal(next.finalDecision.reasonDigest,final(s).reasonDigest);
  await assert.rejects(confirmGovernance(wallet(approver),{...tx,action:final(s,false)}),/expected workflow event/);
  await assert.rejects(submitGovernance(wallet(approver),next,final(next,false)),/Selected/);
 });
 await check('Public extract replacement detects stale reviews and requires the commission',async()=>{
  const s=await snapshot(),a=extract(s,ethers.id('revised extract'));await act(commission,s,a);
  await assert.rejects(submitGovernance(wallet(commission),s,extract(s,ethers.id('third extract'))),/extract changed/);
  const approverView=await snapshot(approver);await assert.rejects(submitGovernance(wallet(approver),approverView,extract(approverView)),/assigned commission/);
 });
 await check('Separate rejection path reaches Rejected and permits its extract digest',async()=>{
  await act(commission,await snapshot(commission,'2'),selection());const s=await snapshot(approver,'2');await act(approver,s,final(s,false));const rejected=await snapshot(commission,'2');assert.equal(rejected.state,9);assert.equal(rejected.finalDecision.approved,false);await act(commission,rejected,extract(rejected,ethers.id('rejection extract')));
 });
 await check('Public API reflects approved and rejected states without leaking selected bidder fields',async()=>{
  for(const [tid,state]of [['1','Approved'],['2','Rejected']]){const response=await inject(app,{url:'/api/tenders/'+tid});assert.equal(response.statusCode,200);const value=JSON.parse(response.payload);assert.equal(value.state,state);assert.notEqual(value.publicExtractDigest,null);assert.equal('selectedBidder'in value,false);}
 });
 await check('Cancellation after selection invalidates an approver review',async()=>{
  await act(commission,await snapshot(commission,'3'),selection());const s=await snapshot(approver,'3');await(await workflow.cancelTender(3,ethers.id('government cancellation'))).wait();await assert.rejects(submitGovernance(wallet(approver),s,final(s)),/Selected/);
 });
 await mkdir('reports',{recursive:true});await writeFile('reports/award-smoke.json',JSON.stringify({project:'constructBlock',generatedAt:new Date().toISOString(),result:'passed',checks,execution:'Actual actor wallet-client functions and public API on an isolated real Hardhat EVM with disposable wallet adapters',limitations:['No real extension prompts or UI clicks','Synthetic verification attestations; decryption has its own integration suite','An extract digest is not proof of website publication']},null,2)+'\n');
}finally{provider.destroy();await connection.close();}
