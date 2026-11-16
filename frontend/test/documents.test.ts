import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDocument,safeDownloadName,viewDocument} from '../src/document-client.ts';
import {validateDocumentRequest} from '../../backend/src/document-protocol.ts';
import type {GovernanceSnapshot} from '../src/governance-client.ts';
const request=validateDocumentRequest({context:{chainId:'31337',workflow:'0x'+'1'.repeat(40),tenderId:'1',bidder:'0x'+'2'.repeat(40),version:'1'},part:0,viewer:'0x'+'3'.repeat(40),timestamp:Date.now().toString(),nonce:'0x'+'4'.repeat(32)});
const response={context:request.context,part:0,requestId:'0x'+'5'.repeat(64),authorizedAtBlock:10,document:{name:'price.txt',type:'text/plain',data:btoa('sensitive offer')}};
test('Restricted response must match every signed target and have bounded decoded content',()=>{
 const doc=parseDocument(response,request);assert.equal(new TextDecoder().decode(doc.data),'sensitive offer');doc.data.fill(0);
 for(const bad of [{...response,part:2},{...response,context:{...request.context,version:'2'}},{...response,requestId:'bad'},{...response,authorizedAtBlock:-1},{...response,document:{...response.document,name:''}},{...response,document:{...response.document,data:''}}])assert.throws(()=>parseDocument(bad,request));
});
test('Download names remove path separators, controls and leading dot sequences',()=>{assert.equal(safeDownloadName('../secret\n.html'),'__secret_.html');assert.equal(safeDownloadName('folder\\secret.txt'),'folder_secret.txt');});
test('Unassigned commissions cannot initiate a viewing signature or HTTP request',async()=>{
 let calls=0;const wallet={request:async()=>{calls++;return [];}};
 await assert.rejects(viewDocument(wallet,{isCommission:false}as GovernanceSnapshot,request.context.bidder,'1',0,()=>true,new AbortController().signal),/assigned commission/);assert.equal(calls,0);
});
