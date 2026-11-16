import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {encryptPart,sha,bytes,base64,unbase64,type EncryptedPart} from '../src/bid-protocol.ts';
import {validateOpeningRequest,openingMessage,type OpeningRequest} from '../src/opening-protocol.ts';
import {verifySelectedPart,loadOpeningKey} from '../src/opening-worker.ts';
const pair=generateKeyPairSync('rsa',{modulusLength:3072}),der=new Uint8Array(pair.publicKey.export({type:'spki',format:'der'})),fingerprint=await sha(der);
const request:OpeningRequest={context:{chainId:'31337',workflow:'0x0000000000000000000000000000000000000001',tenderId:'1',bidder:'0x0000000000000000000000000000000000000002',version:'1'},part:0,service:'0x0000000000000000000000000000000000000003',timestamp:Date.now().toString()};
async function part(name='secret.txt'){return encryptPart(request.context,0,{name,type:'text/plain',data:bytes('sensitive bid contents')},der,fingerprint);}
function verify(p:EncryptedPart){return verifySelectedPart(request,{context:request.context,part:p,contentId:'0x'+'1'.repeat(64),authorizedAtBlock:1},{blockNumber:1,fingerprint,evidence:p.evidence},pair.privateKey);}
test('Opening requests validate exact fields, part bounds and canonical deployment context',()=>{
 assert.deepEqual(validateOpeningRequest(request),request);
 for(const bad of [{...request,part:3},{...request,part:'0'},{...request,extra:'private key'},{...request,timestamp:'invalid'},{...request,context:{...request.context,version:'0'}},{...request,context:{...request.context,workflow:'../file'}}])assert.throws(()=>validateOpeningRequest(bad));
});
test('Opening authorization message binds every target and differs across stages',()=>{
 const message=openingMessage(request);assert.notEqual(message,openingMessage({...request,part:2}));
 for(const field of ['chainId','workflow','tenderId','bidder','version'] as const)assert.notEqual(message,openingMessage({...request,context:{...request.context,[field]:request.context[field]+'1'}}));
 assert.notEqual(message,openingMessage({...request,service:'0x'+'4'.repeat(40)}));
});
test('Valid selected part is verified without returning document data',async()=>{const result=await verify(await part());assert.deepEqual(result,{verified:true,code:'VERIFIED'});assert.ok(!JSON.stringify(result).includes('sensitive'));});
test('Part or context substitution is operational failure, not a bidder Failed outcome',async()=>{const p=await part();await assert.rejects(verifySelectedPart(request,{context:{...request.context,tenderId:'2'},part:p,contentId:'x',authorizedAtBlock:1},{blockNumber:1,fingerprint,evidence:p.evidence},pair.privateKey),{code:'OPENING_EVIDENCE_MISMATCH'});});
test('Tampered retrieval bytes cannot be attributed as bidder failure',async()=>{const p=await part();p.ciphertext=base64(new Uint8Array(unbase64(p.ciphertext).length));await assert.rejects(verify(p),{code:'OPENING_EVIDENCE_MISMATCH'});});
test('An invalid wrapped key whose bytes match on-chain evidence yields Failed verification',async()=>{const p=await part();p.wrapped=base64(new Uint8Array(384));p.evidence.wrappedPackageHash=await sha(unbase64(p.wrapped));assert.deepEqual(await verify(p),{verified:false,code:'WRAPPED_KEY_INVALID'});});
test('A validly encrypted but invalid document envelope yields Failed verification',async()=>{assert.deepEqual(await verify(await part('')),{verified:false,code:'DOCUMENT_INVALID'});});
test('Private key loader enforces permissions, key identity and bounded file names',async()=>{
 const root=await mkdtemp(join(tmpdir(),'constructblock-opening-key-')),file=join(root,'initial.pem');
 try{await writeFile(file,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});assert.equal((await loadOpeningKey(root,0,fingerprint)).type,'private');
 await assert.rejects(loadOpeningKey(root,0,'0x'+'1'.repeat(64)),{code:'CUSTODY_KEY_UNAVAILABLE'});
 await chmod(file,0o644);await assert.rejects(loadOpeningKey(root,0,fingerprint),{code:'CUSTODY_KEY_UNAVAILABLE'});
 await assert.rejects(loadOpeningKey(root,1,fingerprint),{code:'CUSTODY_KEY_UNAVAILABLE'});await assert.rejects(loadOpeningKey(root,3,fingerprint),/Invalid part/);
 }finally{await rm(root,{recursive:true,force:true});}
});
