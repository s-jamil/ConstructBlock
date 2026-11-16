import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,privateDecrypt,constants} from 'node:crypto';
import {mkdtemp,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Wallet} from 'ethers';
import {bytes,encryptPart,sha,unbase64} from '../src/bid-protocol.ts';
import {validateDocumentRequest,documentMessage,type DocumentRequest} from '../src/document-protocol.ts';
import {DocumentService} from '../src/document-service.ts';
import {createDocumentApp} from '../src/document-app.ts';
import {vaultLoader,configuredKeyLoader,privateFile} from '../src/custody.ts';
import {loadOpeningKey,verifySelectedPart} from '../src/opening-worker.ts';
// @ts-ignore native HTTP test transport
import {inject} from './inject.mjs';
const pair=generateKeyPairSync('rsa',{modulusLength:3072}),spki=new Uint8Array(pair.publicKey.export({type:'spki',format:'der'})),fingerprint=await sha(spki),viewer=Wallet.createRandom(),other=Wallet.createRandom();
const request=():DocumentRequest=>({context:{chainId:'31337',workflow:'0x'+'1'.repeat(40),tenderId:'1',bidder:'0x'+'2'.repeat(40),version:'1'},part:0,viewer:viewer.address.toLowerCase(),timestamp:Date.now().toString(),nonce:'0x'+crypto.randomUUID().replaceAll('-','')});
async function fixture(fn:(f:any)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'constructblock-docs-'));const r=request(),part=await encryptPart(r.context,0,{name:'secret.txt',type:'text/plain',data:bytes('confidential offer')},spki,fingerprint);
 const access={blockNumber:1,fingerprint,evidence:part.evidence};let reads=0,keys=0;
 const chain={documentAccess:async()=>{reads++;return access;}},storage={selectedPart:async()=>({context:r.context,contentId:'0x'+'3'.repeat(64),part,authorizedAtBlock:1})};
 const service=new DocumentService(chain,storage,async()=>{keys++;return pair.privateKey;},join(root,'audit'));
 try{await fn({root,r,part,access,chain,storage,service,keyReads:()=>keys,reads:()=>reads});}finally{await rm(root,{recursive:true,force:true});}
}
test('Viewing request schema and signature text bind context, viewer, nonce and part',()=>{
 const r=request();assert.deepEqual(validateDocumentRequest(r),r);
 for(const bad of [{...r,part:3},{...r,nonce:'../key'},{...r,service:r.viewer},{...r,context:{...r.context,version:'0'}}])assert.throws(()=>validateDocumentRequest(bad));
 for(const changed of [{...r,part:2},{...r,nonce:'0x'+'f'.repeat(32)},{...r,viewer:other.address.toLowerCase()},{...r,context:{...r.context,version:'2'}}])assert.notEqual(documentMessage(changed),documentMessage(r));
});
test('Unsigned, forged, expired and far-future viewing requests never read a key',()=>fixture(async({r,service,keyReads}:any)=>{
 await assert.rejects(service.view(r,''),{code:'INVALID_SIGNATURE'});await assert.rejects(service.view(r,await other.signMessage(documentMessage(r))),{code:'INVALID_SIGNATURE'});
 for(const timestamp of [String(Date.now()-61000),String(Date.now()+10000)]){const old={...r,timestamp};await assert.rejects(service.view(old,await viewer.signMessage(documentMessage(old))),{code:'EXPIRED_AUTHORIZATION'});}assert.equal(keyReads(),0);
}));
test('Document release is verified, audited without contents, and single use across restarts',()=>fixture(async({root,r,chain,storage,service}:any)=>{
 const signature=await viewer.signMessage(documentMessage(r)),result=await service.view(r,signature);assert.equal(Buffer.from(unbase64(result.document.data)).toString(),'confidential offer');
 const audit=await readFile(join(root,'audit',(await readdir(join(root,'audit')))[0]),'utf8');assert.match(audit,/release-authorized/);assert.ok(!audit.includes('confidential offer')&&!audit.includes(signature)&&!audit.includes('secret.txt'));
 const restarted=new DocumentService(chain,storage,async()=>pair.privateKey,join(root,'audit'));await assert.rejects(restarted.view(r,signature),{code:'DOCUMENT_REQUEST_REPLAYED'});
}));
test('Concurrent copies of one signed authorization release exactly once',()=>fixture(async({r,service}:any)=>{
 const signature=await viewer.signMessage(documentMessage(r)),results=await Promise.allSettled([service.view(r,signature),service.view(r,signature)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected'&&(x.reason as any).code==='DOCUMENT_REQUEST_REPLAYED').length,1);
}));
test('Denied chain authorization and audit failure prevent private-key access',()=>fixture(async({root,r,service,chain,keyReads}:any)=>{
 chain.documentAccess=async()=>{throw Object.assign(new Error('denied'),{code:'DENIED'});};await assert.rejects(service.view(r,await viewer.signMessage(documentMessage(r))));assert.equal(keyReads(),0);
 const block=join(root,'not-directory');await writeFile(block,'x');const blocked=new DocumentService(chain,service.storage,service.loadKey,block),next=request();await assert.rejects(blocked.view(next,await viewer.signMessage(documentMessage(next))),{code:'AUDIT_UNAVAILABLE'});assert.equal(keyReads(),0);
}));
test('Revocation after decryption or substituted encrypted bytes never releases contents',()=>fixture(async({r,service,chain,part}:any)=>{
 let calls=0;const original=chain.documentAccess;chain.documentAccess=async()=>{if(++calls===3)throw new Error('role revoked');return original();};await assert.rejects(service.view(r,await viewer.signMessage(documentMessage(r))));
 chain.documentAccess=original;part.ciphertext=part.ciphertext.replace(/^./,part.ciphertext[0]==='A'?'B':'A');const next=request();await assert.rejects(service.view(next,await viewer.signMessage(documentMessage(next))),{code:'OPENING_EVIDENCE_MISMATCH'});
}));
test('HTTP viewer enforces origin, JSON, signature, response privacy and keeps public routes absent',()=>fixture(async({r,service}:any)=>{
 const app=createDocumentApp(service,'http://127.0.0.1:5173'),signature=await viewer.signMessage(documentMessage(r));
 const denied=await inject(app,{method:'POST',url:'/api/documents/view',body:r,headers:{origin:'https://attacker.example','x-document-signature':signature}});assert.equal(denied.statusCode,403);
 const ok=await inject(app,{method:'POST',url:'/api/documents/view',body:r,headers:{origin:'http://127.0.0.1:5173','x-document-signature':signature}});assert.equal(ok.statusCode,200);assert.match(ok.headers['cache-control'],/no-store/);assert.equal(ok.headers['x-content-type-options'],'nosniff');
 assert.equal((await inject(app,{url:'/api/documents/view'})).statusCode,404);
}));
test('Vault adapter decrypts existing browser RSA OAEP material with pinned non-exportable key metadata',()=>fixture(async({root,r,part}:any)=>{
 const token=join(root,'token');await writeFile(token,'test-only-token',{mode:0o600});const calls:any[]=[];
 const loader=vaultLoader({address:'https://vault.example',mount:'transit',tokenFile:token,keys:[{fingerprint,name:'initial',version:2}],fetch:async(url,options)=>{
  calls.push({url:String(url),options});if(options?.method==='GET')return Response.json({data:{type:'rsa-3072',exportable:false,allow_plaintext_backup:false,keys:{'2':{public_key:pair.publicKey.export({type:'spki',format:'pem'})}}}});
  const body=JSON.parse(options?.body as string);assert.equal(body.hash_algorithm,'sha2-256');assert.equal(body.padding_scheme,'oaep');assert.ok(body.ciphertext.startsWith('vault:v2:'));
  return Response.json({data:{plaintext:privateDecrypt({key:pair.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(body.ciphertext.slice('vault:v2:'.length),'base64')).toString('base64')}});
 }});
 const key=await loader(0,fingerprint);assert.ok('unwrap'in key);if('unwrap'in key){const material=await key.unwrap(unbase64(part.wrapped));assert.equal(material.length,64);material.fill(0);}assert.equal(calls.length,2);
 const selected={context:r.context,part,contentId:'0x'+'3'.repeat(64),authorizedAtBlock:1};
 assert.deepEqual(await verifySelectedPart({context:r.context,part:0,service:r.viewer,timestamp:r.timestamp},selected,{blockNumber:1,fingerprint,evidence:part.evidence},key),{verified:true,code:'VERIFIED'});
 await assert.rejects(loader(0,'0x'+'9'.repeat(64)),{code:'CUSTODY_KEY_UNAVAILABLE'});
}));
test('Vault rejects exportable or mismatched keys, unsafe URLs and remote failures without leaking errors',()=>fixture(async({root}:any)=>{
 const token=join(root,'token');await writeFile(token,'test-only-token',{mode:0o600});const config={address:'https://vault.example',mount:'transit',tokenFile:token,keys:[{fingerprint,name:'initial',version:1}]};
 assert.throws(()=>vaultLoader({...config,address:'http://vault.example'}));
 for(const data of [{type:'rsa-3072',exportable:true,allow_plaintext_backup:false},{type:'rsa-2048',exportable:false,allow_plaintext_backup:false},{type:'rsa-3072',exportable:false,allow_plaintext_backup:false,keys:{'1':{public_key:'invalid'}}}])await assert.rejects(vaultLoader({...config,fetch:async()=>Response.json({data})})(0,fingerprint),{code:'CUSTODY_KEY_UNAVAILABLE'});
 await assert.rejects(vaultLoader({...config,fetch:async()=>new Response('sensitive vault internals',{status:403})})(0,fingerprint),{code:'CUSTODY_KEY_UNAVAILABLE'});
}));
test('Custody configuration never silently falls back to local files or allows production local custody',async()=>{
 await assert.rejects(configuredKeyLoader({}),/CUSTODY_PROVIDER/);await assert.rejects(configuredKeyLoader({CUSTODY_PROVIDER:'local',CHAIN_ID:'1',CUSTODY_DIR:'/tmp'}),/only/);await assert.rejects(configuredKeyLoader({CUSTODY_PROVIDER:'local',CHAIN_ID:'31337',NODE_ENV:'production',CUSTODY_DIR:'/tmp'}),/only/);await assert.rejects(configuredKeyLoader({CUSTODY_PROVIDER:'vault'}),/Configure/);
});
test('Private credential and local-key reads reject symbolic links',()=>fixture(async({root}:any)=>{
 const real=join(root,'real');await writeFile(real,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});await symlink(real,join(root,'initial.pem'));await assert.rejects(loadOpeningKey(root,0,fingerprint),{code:'CUSTODY_KEY_UNAVAILABLE'});await assert.rejects(privateFile(join(root,'initial.pem')),{code:'CUSTODY_KEY_UNAVAILABLE'});
}));
test('Viewer HTTP rate limit bounds repeated failed signatures before custody access',()=>fixture(async({r,service,keyReads}:any)=>{
 const app=createDocumentApp(service,'http://127.0.0.1:5173');let response;
 for(let i=0;i<21;i++)response=await inject(app,{method:'POST',url:'/api/documents/view',body:r,headers:{origin:'http://127.0.0.1:5173'}});
 assert.equal(response.statusCode,429);assert.equal(keyReads(),0);
}));
