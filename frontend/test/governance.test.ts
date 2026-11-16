import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,ZeroHash,id} from 'ethers';
import artifact from '../../backend/src/abi/ProcurementWorkflow.json' with {type:'json'};
import {validateGovernanceAction,parseGovernanceReceipt,restoreGovernanceTransaction,type GovernanceTransaction} from '../src/governance-client.ts';
const account='0x0000000000000000000000000000000000000001',workflow='0x0000000000000000000000000000000000000002',bidder='0x0000000000000000000000000000000000000003';
const abi=new Interface(artifact.abi),digest=id('human record');
const tx:GovernanceTransaction={hash:id('tx'),account,workflow,chainId:'31337',tenderId:'1',action:{kind:'admission',bidder,version:'1',accept:true,reasonDigest:digest}};
function receipt(event='AdmissionRecorded',args:unknown[]=[1n,bidder,true,digest]){const encoded=abi.encodeEventLog(abi.getEvent(event)!,args);return {hash:tx.hash,from:account,to:workflow,status:1,blockNumber:9,logs:[{address:workflow,...encoded}]};}
test('Action validator rejects invalid parts, decisions and zero evidence',()=>{
 for(const a of [{kind:'approve',part:3},{kind:'request',part:'1'},{kind:'admission',bidder,version:'0',accept:true,reasonDigest:digest},{kind:'technical',bidder,version:'1',accept:'yes',reasonDigest:digest},{kind:'admission',bidder,version:'1',accept:true,reasonDigest:ZeroHash},{kind:'delete'}])assert.throws(()=>validateGovernanceAction(a));
});
test('Valid review preserves exact version and normalizes evidence',()=>{assert.deepEqual(validateGovernanceAction({...tx.action,version:'18446744073709551615',reasonDigest:digest.toUpperCase().replace('0X','0x')}),{...tx.action,version:'18446744073709551615'});});
test('Receipt confirms the exact human decision',()=>{assert.deepEqual(parseGovernanceReceipt(receipt(),tx),{blockNumber:9,hash:tx.hash});});
test('Receipt rejects a different bidder, decision or reason',()=>{
 for(const args of [[1n,account,true,digest],[1n,bidder,false,digest],[1n,bidder,true,id('different')]])assert.throws(()=>parseGovernanceReceipt(receipt('AdmissionRecorded',args),tx),/expected workflow event/);
});
test('Receipt rejects reverted or unrelated transactions',()=>{assert.throws(()=>parseGovernanceReceipt({...receipt(),status:0},tx),{code:'TRANSACTION_REVERTED'});assert.throws(()=>parseGovernanceReceipt({...receipt(),hash:id('other')},tx),/Unexpected/);});
test('Another contract or duplicate event cannot confirm an action',()=>{const r=receipt();assert.throws(()=>parseGovernanceReceipt({...r,logs:[{...r.logs[0],address:bidder}]},tx));assert.throws(()=>parseGovernanceReceipt({...r,logs:[...r.logs,...r.logs]},tx));});
test('Removed custodian approvals cannot be restored or submitted',()=>{assert.throws(()=>validateGovernanceAction({kind:'approve',part:0}),/Unsupported/);assert.throws(()=>restoreGovernanceTransaction({...tx,action:{kind:'approve',part:0}}),/Unsupported/);});
test('Saved transaction recovery validates deployment, hash and reviewed action',()=>{assert.deepEqual(restoreGovernanceTransaction(tx),tx);for(const bad of [{...tx,hash:'bad'},{...tx,chainId:'0'},{...tx,tenderId:'0'},{...tx,account:'0x'+'0'.repeat(40)},{...tx,action:{kind:'unsupported'}}])assert.throws(()=>restoreGovernanceTransaction(bad));});

test('Receipt must come from the reviewed wallet and target workflow',()=>{const r=receipt();assert.throws(()=>parseGovernanceReceipt({...r,from:bidder},tx),/sender/);assert.throws(()=>parseGovernanceReceipt({...r,to:bidder},tx),/destination/);});
const selected={selectedBidder:bidder,selectionDigest:id('selection record')};
test('Award review rejects zero selected bidder, zero evidence and invalid acceptance types',()=>{
 for(const a of [{kind:'select',bidder,version:'1',reasonDigest:ZeroHash},{kind:'final',...selected,accept:true,reasonDigest:ZeroHash},{kind:'final',...selected,accept:'true',reasonDigest:digest},{kind:'extract',...selected,selectedBidder:'0x'+'0'.repeat(40),reasonDigest:digest,previousExtractDigest:ZeroHash}])assert.throws(()=>validateGovernanceAction(a));
});
test('Selection receipt matches the reviewed bidder and decision evidence',()=>{
 const award={...tx,action:{kind:'select' as const,bidder,version:'1',reasonDigest:digest}};
 assert.ok(parseGovernanceReceipt(receipt('SelectionRecorded',[1n,bidder,digest]),award));
 assert.throws(()=>parseGovernanceReceipt(receipt('SelectionRecorded',[1n,account,digest]),award));
 assert.throws(()=>parseGovernanceReceipt(receipt('SelectionRecorded',[1n,bidder,id('another record')]),award));
});
test('Final approval receipt cannot be confused with rejection',()=>{
 const award={...tx,action:{kind:'final' as const,...selected,accept:true,reasonDigest:digest}};
 assert.ok(parseGovernanceReceipt(receipt('StateChanged',[1n,6,account,digest]),award));
 assert.throws(()=>parseGovernanceReceipt(receipt('StateChanged',[1n,9,account,digest]),award));
});
test('Final rejection receipt requires the actual reason and actor',()=>{
 const award={...tx,action:{kind:'final' as const,...selected,accept:false,reasonDigest:digest}};
 assert.ok(parseGovernanceReceipt(receipt('StateChanged',[1n,9,account,digest]),award));
 assert.throws(()=>parseGovernanceReceipt(receipt('StateChanged',[1n,9,bidder,digest]),award));
 assert.throws(()=>parseGovernanceReceipt(receipt('StateChanged',[1n,9,account,id('other reason')]),award));
});
test('Extract confirmation checks its digest and event type',()=>{
 const award={...tx,action:{kind:'extract' as const,...selected,reasonDigest:digest,previousExtractDigest:ZeroHash}};
 assert.ok(parseGovernanceReceipt(receipt('PublicExtractRecorded',[1n,digest,123n]),award));
 assert.throws(()=>parseGovernanceReceipt(receipt('PublicExtractRecorded',[1n,id('other extract'),123n]),award));
 assert.throws(()=>parseGovernanceReceipt(receipt('SelectionRecorded',[1n,bidder,digest]),award));
});
test('Saved final decision retains its reviewed selection context',()=>{
 const award={...tx,action:{kind:'final' as const,...selected,accept:false,reasonDigest:digest}};
 assert.deepEqual(restoreGovernanceTransaction(award),award);
 assert.throws(()=>restoreGovernanceTransaction({...award,action:{...award.action,selectionDigest:ZeroHash}}));
});
test('Saved extract review retains the previous digest for replacement checks',()=>{
 const award={...tx,action:{kind:'extract' as const,...selected,reasonDigest:digest,previousExtractDigest:ZeroHash}};
 assert.deepEqual(restoreGovernanceTransaction(award),award);
 assert.throws(()=>restoreGovernanceTransaction({...award,action:{...award.action,previousExtractDigest:'invalid'}}));
});

function openingReceipt(part=0){
 const r=receipt('OpeningRequested',[1n,part,account]);
 for(const [event,args]of [['OpeningAuthorized',[1n,part]],['StateChanged',[1n,[2,3,4][part],account,ZeroHash]]] as const)r.logs.push({address:workflow,...abi.encodeEventLog(abi.getEvent(event)!,args)});
 return r;
}
test('Opening receipt requires request, authorization and the exact stage transition',()=>{
 for(const part of [0,1,2])assert.ok(parseGovernanceReceipt(openingReceipt(part),{...tx,action:{kind:'request',part}}));
});
test('A request alone or a missing stage transition cannot confirm opening',()=>{
 const opening={...tx,action:{kind:'request' as const,part:0}},r=openingReceipt();
 for(const logs of [[r.logs[0]],[r.logs[0],r.logs[1]],[r.logs[0],r.logs[2]]])assert.throws(()=>parseGovernanceReceipt({...r,logs},opening),/authorization/);
});
test('Opening confirmation rejects duplicated authorization and a different part',()=>{
 const opening={...tx,action:{kind:'request' as const,part:0}},r=openingReceipt();
 assert.throws(()=>parseGovernanceReceipt({...r,logs:[...r.logs,r.logs[1]]},opening),/authorization/);
 assert.throws(()=>parseGovernanceReceipt(openingReceipt(1),opening));
});
