import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import hre from 'hardhat';
import {loadGovernance,submitGovernance,confirmGovernance,actionUnavailable} from '../../frontend/src/governance-client.ts';
const connection=await hre.network.create(),{ethers}=connection;
const [government,officer,commission,c1,c2,service,approver,bidder,outsider,otherCommission,bidder2,bidder3]=await ethers.getSigners();
const registry=await ethers.deployContract('RoleRegistry',[government.address,86400]);await registry.waitForDeployment();
for(const [role,actor]of [['OFFICER_ROLE',officer],['COMMISSION_ROLE',commission],['COMMISSION_ROLE',otherCommission],['OPENING_SERVICE_ROLE',service]])await(await registry.grantRole(ethers.id(role),actor.address)).wait();
for(const b of [bidder,bidder2,bidder3])await(await registry.approveBidder(b.address)).wait();
const workflow=await ethers.deployContract('ProcurementWorkflow',[await registry.getAddress()]);await workflow.waitForDeployment();
const deployment={ready:true,chainId:'31337',expectedChainId:'31337',blockNumber:0,contracts:{roleRegistry:await registry.getAddress(),procurementWorkflow:await workflow.getAddress(),registryLinked:true}};
let sends=0;
function wallet(actor,chain){return {request:async({method,params})=>{
 if(method==='eth_accounts'||method==='eth_requestAccounts')return [actor.address];if(method==='eth_chainId'&&chain)return chain;
 if(method==='eth_sendTransaction'){assert.equal(params[0].from.toLowerCase(),actor.address.toLowerCase());sends++;}
 return connection.provider.request({method,params:params??[]});
}};}
const evidence={commitment:ethers.id('commitment'),ciphertextHash:ethers.id('cipher'),wrappedPackageHash:ethers.id('wrapped')},zero={commitment:ethers.ZeroHash,ciphertextHash:ethers.ZeroHash,wrappedPackageHash:ethers.ZeroHash};
const deadline=(await ethers.provider.getBlock('latest')).timestamp+3600;
for(const technical of [true,false])await(await workflow.connect(officer).publishTender(ethers.id('dossier'),deadline,technical,commission.address,[ethers.id('initial'),technical?ethers.id('technical'):ethers.ZeroHash,ethers.id('financial')])).wait();
for(const b of [bidder,bidder2,bidder3])await(await workflow.connect(b).submitBid(1,1,evidence,evidence,evidence)).wait();
await(await workflow.connect(bidder3).withdrawBid(1)).wait();await(await workflow.connect(bidder).submitBid(2,1,evidence,zero,evidence)).wait();
const checks=[];
async function check(label,fn){await fn();checks.push(label);console.log('PASS '+label);}
async function action(actor,a,tid='1'){
 const w=wallet(actor),s=await loadGovernance(w,deployment,tid),tx=await submitGovernance(w,s,a);assert.ok(await confirmGovernance(w,tx));return tx;
}
try{
 await check('Unrelated wallets, unassigned commissions and wrong networks are rejected',async()=>{
  await assert.rejects(loadGovernance(wallet(outsider),deployment,'1'),/neither/);await assert.rejects(loadGovernance(wallet(otherCommission),deployment,'1'),/neither/);await assert.rejects(loadGovernance(wallet(commission,'0x1'),deployment,'1'),/chain/);
 });
 await check('Legacy opening deployments are rejected before actor actions',async()=>{
  const legacy={request:async input=>input.method==='eth_call'&&input.params[0].data===workflow.interface.encodeFunctionData('OPENING_POLICY_VERSION')?'0x':wallet(commission).request(input)};
  await assert.rejects(loadGovernance(legacy,deployment,'1'),/policy 2/);assert.equal(sends,0);
 });
 await check('Actor dashboard includes current versions, withdrawn bids and Pending outcomes',async()=>{
  const s=await loadGovernance(wallet(commission),deployment,'1');assert.equal(s.isCommission,true);assert.equal(s.bids.length,3);assert.equal(s.bids.find(b=>b.address===bidder3.address).active,false);assert.deepEqual(s.bids[0].outcomes,[0,0,0]);
  await assert.rejects(submitGovernance(wallet(commission),s,{kind:'close'}),/deadline/);await assert.rejects(submitGovernance(wallet(commission),s,{kind:'request',part:0}),/deadline/);assert.equal(sends,0);
 });
 await check('Changed account, revoked role, paused platform and cancelled review never broadcast',async()=>{
  const s=await loadGovernance(wallet(commission),deployment,'1');
  await assert.rejects(submitGovernance(wallet(otherCommission),s,{kind:'request',part:0}),/neither/);
  await assert.rejects(submitGovernance(wallet(commission),s,{kind:'close'},()=>false),/changed/);
  await(await registry.revokeRole(ethers.id('COMMISSION_ROLE'),commission.address)).wait();await assert.rejects(submitGovernance(wallet(commission),s,{kind:'close'}),/neither/);await(await registry.grantRole(ethers.id('COMMISSION_ROLE'),commission.address)).wait();
  await(await workflow.setPaused(true)).wait();await assert.rejects(submitGovernance(wallet(commission),s,{kind:'close'}),/paused/);await(await workflow.setPaused(false)).wait();assert.equal(sends,0);
 });
 await connection.provider.request({method:'evm_setNextBlockTimestamp',params:[deadline]});await connection.provider.request({method:'evm_mine',params:[]});
 await check('Commission wallet closes tender and receives an exact StateChanged confirmation',async()=>{const tx=await action(commission,{kind:'close'});assert.equal((await loadGovernance(wallet(commission),deployment,'1')).state,1);await assert.rejects(confirmGovernance(wallet(commission),{...tx,account:c1.address}),/sender/);});
 await check('Unassigned wallets cannot request a stage; commission authorizes initial opening directly',async()=>{
  await assert.rejects(loadGovernance(wallet(c1),deployment,'1'),/neither/);
  await action(commission,{kind:'request',part:0});
  const s=await loadGovernance(wallet(commission),deployment,'1');assert.equal(s.state,2);assert.equal(s.openings[0].requested,true);assert.equal(s.openings[0].authorized,true);assert.equal(s.pendingOpenings,'2');
 });
 await check('Duplicate opening requests are blocked',async()=>{
  const s=await loadGovernance(wallet(commission),deployment,'1');await assert.rejects(submitGovernance(wallet(commission),s,{kind:'request',part:0}),/already exists/);
 });
 await check('Incomplete initial reviews cannot be bypassed for later stages',async()=>{
  const s=await loadGovernance(wallet(commission),deployment,'1');for(const part of [1,2])await assert.rejects(submitGovernance(wallet(commission),s,{kind:'request',part}),/preceding/);
 });
 await check('Pending verification and failed verification cannot be admitted',async()=>{
  let s=await loadGovernance(wallet(commission),deployment,'1');const admit={kind:'admission',bidder:bidder.address,version:'1',accept:true,reasonDigest:ethers.id('admission record')};await assert.rejects(submitGovernance(wallet(commission),s,admit),/opening service/);
  await(await workflow.connect(service).recordOpeningResult(1,bidder.address,1,0,true,ethers.id('verified'))).wait();await(await workflow.connect(service).recordOpeningResult(1,bidder2.address,1,0,false,ethers.id('failed'))).wait();
  s=await loadGovernance(wallet(commission),deployment,'1');assert.equal(s.bids.find(b=>b.address===bidder2.address).outcomes[0],2);await assert.rejects(submitGovernance(wallet(commission),s,{...admit,bidder:bidder2.address}),/failed verification/);
 });
 await check('Commission records separate admission and exclusion decisions and cannot overwrite them',async()=>{
  const reasonDigest=ethers.id('human admission record');await action(commission,{kind:'admission',bidder:bidder.address,version:'1',accept:true,reasonDigest});let s=await loadGovernance(wallet(commission),deployment,'1');
  assert.ok(actionUnavailable(s,{kind:'request',part:1}));await assert.rejects(submitGovernance(wallet(commission),s,{kind:'admission',bidder:bidder.address,version:'1',accept:false,reasonDigest}),/not available/);
  await action(commission,{kind:'admission',bidder:bidder2.address,version:'1',accept:false,reasonDigest:ethers.id('exclusion record')});s=await loadGovernance(wallet(commission),deployment,'1');assert.equal(s.admissionDecisions,'2');assert.equal(actionUnavailable(s,{kind:'request',part:1}),null);
 });
 await check('Technical stage requires its own commission request and verification before a human decision',async()=>{
  await action(commission,{kind:'request',part:1});let s=await loadGovernance(wallet(commission),deployment,'1');const decision={kind:'technical',bidder:bidder.address,version:'1',accept:true,reasonDigest:ethers.id('technical decision')};await assert.rejects(submitGovernance(wallet(commission),s,decision),/opening service/);
  await(await workflow.connect(service).recordOpeningResult(1,bidder.address,1,1,true,ethers.id('technical verified'))).wait();await action(commission,decision);
 });
 await check('Financial opening follows completed technical decisions and commission authorization',async()=>{await action(commission,{kind:'request',part:2});const s=await loadGovernance(wallet(commission),deployment,'1');assert.equal(s.state,4);assert.equal(s.openings[2].authorized,true);});
 await check('Optional technical stage is omitted and financial opening follows initial admission',async()=>{
  await action(commission,{kind:'close'},'2');await action(commission,{kind:'request',part:0},'2');
  await(await workflow.connect(service).recordOpeningResult(2,bidder.address,1,0,true,ethers.id('initial verified'))).wait();await action(commission,{kind:'admission',bidder:bidder.address,version:'1',accept:true,reasonDigest:ethers.id('admit')},'2');
  const s=await loadGovernance(wallet(commission),deployment,'2');assert.ok(actionUnavailable(s,{kind:'request',part:1}));await action(commission,{kind:'request',part:2},'2');
 });
 await mkdir('reports',{recursive:true});await writeFile('reports/governance-smoke.json',JSON.stringify({project:'constructBlock',generatedAt:new Date().toISOString(),result:'passed',checks,execution:'Actual frontend actor-client functions with a disposable EIP-1193 wallet adapter on an isolated Hardhat EVM',limitations:['No real browser extension approval dialog or UI click automation','Verification outcomes are supplied by the test opening-service actor; the separate opening integration tests decryption','No document viewing, selection or final-approval interface']},null,2)+'\n');
}finally{await connection.close();}
