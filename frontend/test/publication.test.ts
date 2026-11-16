import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroHash, id } from 'ethers';
import { validatePublication, parsePublicationReceipt, publicationMessage, workflowAbi, type PublicationForm, type Submission } from '../src/publication.ts';
const now = Date.parse('2026-10-25T10:00:00Z');
const commission = '0x0000000000000000000000000000000000000002';
const form: PublicationForm = { dossierDigest:id('dossier'), deadline:'2026-10-26T10:00:00Z', commission, requiresTechnicalOffer:false, initialKey:id('initial'), technicalKey:'', financialKey:id('financial') };
test('Valid configuration preserves digests and omits unused technical key', () => {
 const value = validatePublication(form, now); assert.equal(value.keyFingerprints[1], ZeroHash); assert.equal(value.deadline, 1793008800n);
});
for (const [label, patch] of Object.entries({ 'past deadline':{deadline:'2026-10-24T10:00:00Z'}, 'invalid deadline':{deadline:'bad'}, 'zero commission':{commission:'0x'+'0'.repeat(40)}, 'invalid address':{commission:'bad'}, 'zero dossier':{dossierDigest:ZeroHash}, 'short initial key':{initialKey:'0x1234'}, 'missing financial key':{financialKey:''}, 'missing required technical key':{requiresTechnicalOffer:true} })) {
 test(`Rejects ${label}`, () => assert.throws(() => validatePublication({...form,...patch},now), {code:'INVALID_FORM'}));
}
test('Required technical key is retained', () => assert.equal(validatePublication({...form,requiresTechnicalOffer:true,technicalKey:id('technical')},now).keyFingerprints[1],id('technical')));
const submission: Submission = {hash:id('tx'),officer:'0x0000000000000000000000000000000000000001', workflow:'0x0000000000000000000000000000000000000003',chainId:'31337',input:validatePublication(form,now)};
const abi = new Interface(workflowAbi);
const event = abi.encodeEventLog(abi.getEvent('TenderPublished')!, [7n, submission.officer, commission, submission.input.deadline, false, form.dossierDigest, submission.input.keyFingerprints]);
const receipt = { status:1, hash:submission.hash, blockNumber:12, logs:[{address:submission.workflow, ...event}] };
test('Confirms exact publication event and tender ID', () => assert.deepEqual(parsePublicationReceipt(receipt as any,submission),{tenderId:'7',transactionHash:submission.hash,blockNumber:12}));
test('Rejects reverted receipt', () => assert.throws(() => parsePublicationReceipt({...receipt,status:0} as any,submission),{code:'TRANSACTION_REVERTED'}));
test('Rejects different transaction receipt', () => assert.throws(() => parsePublicationReceipt({...receipt,hash:id('other')} as any,submission),{code:'WRONG_RECEIPT'}));
test('Rejects another contract emitting same event', () => assert.throws(() => parsePublicationReceipt({...receipt,logs:[{...receipt.logs[0],address:commission}]} as any,submission),{code:'MISSING_PUBLICATION_EVENT'}));
test('Rejects mismatched tender metadata', () => assert.throws(() => parsePublicationReceipt(receipt as any,{...submission,input:{...submission.input,dossierDigest:id('different')}}),{code:'MISSING_PUBLICATION_EVENT'}));
test('Rejects missing and duplicate events', () => {
 for (const logs of [[],[...receipt.logs,...receipt.logs]]) assert.throws(() => parsePublicationReceipt({...receipt,logs} as any,submission),{code:'MISSING_PUBLICATION_EVENT'});
});
test('Wallet refusal and pending request produce actionable messages', () => {
 assert.match(publicationMessage({info:{error:{code:4001}}}),/declined/); assert.match(publicationMessage({code:-32002}),/already open/); assert.doesNotMatch(publicationMessage(new Error('secret RPC credentials')),/secret/);
});
