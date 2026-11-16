// Explicit opt-in: requires the actual installed OrbitDB runtime and local sockets.
// It is deliberately not included in the *.test.ts adapter/unit test command.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {generateKeyPairSync} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {openOrbitRuntime} from '../dist/orbitdb-runtime.js';
import {OrbitDbCiphertextStore} from '../dist/orbitdb-store.js';
import {OrbitDbClient} from '../dist/orbitdb-client.js';
import {serveOrbitStorage} from '../dist/orbitdb-server.js';
import {PROTOCOL,encryptPart,canonicalBundle,bytes,sha,MAX_FILE_BYTES} from '../dist/bid-protocol.js';
import {verifySelectedPart} from '../dist/opening-worker.js';
const exec=promisify(execFile),worker=fileURLToPath(new URL('./orbitdb-process.mjs',import.meta.url));
test('Actual OrbitDB persists maximum bid parts across processes and serves two clients without replication',{timeout:180000},async()=>{
 const root=await mkdtemp('/tmp/cb-orbitdb-live-'),directory=join(root,'data'),file=join(root,'encrypted.json'),socket=join(root,'storage.sock');
 let runtime,owner;
 try{
  const pair=generateKeyPairSync('rsa',{modulusLength:3072}),der=new Uint8Array(pair.publicKey.export({type:'spki',format:'der'})),fingerprint=await sha(der);
  const context={chainId:'31337',workflow:'0x'+'1'.repeat(40),tenderId:'1',bidder:'0x'+'2'.repeat(40),version:'1'};
  const bundle={protocol:PROTOCOL,context,parts:[]};
  for(const part of [0,1,2])bundle.parts.push(await encryptPart(context,part,{name:'synthetic.txt',type:'text/plain',data:new Uint8Array(MAX_FILE_BYTES).fill(65)},der,fingerprint));
  const serialized=canonicalBundle(bundle),id=await sha(bytes(serialized));await writeFile(file,serialized,{mode:0o600});
  const run=async action=>{
   const {stdout}=await exec(process.execPath,[worker,action,directory,file,id],{timeout:90000,maxBuffer:1024*1024});
   return JSON.parse(stdout.trim().split('\n').at(-1));
  };
  const first=await run('write'),second=await run('read');assert.deepEqual(second,first);assert.equal(second.contentId,id);assert.equal(second.count,1);
  runtime=await openOrbitRuntime(directory);const store=new OrbitDbCiphertextStore(runtime.database);
  assert.equal(runtime.address,first.address);assert.equal(runtime.database.peers.size,0);
  owner=await serveOrbitStorage(store,socket,{provider:'orbitdb',address:runtime.address,sync:false});
  const writer=new OrbitDbClient(socket),viewer=new OrbitDbClient(socket,true);await writer.put(id,serialized);
  const restored=JSON.parse(await viewer.get(id));assert.deepEqual(restored,bundle);assert.equal((await stat(socket)).mode&0o777,0o600);
  await assert.rejects(viewer.put(id,serialized),{code:'STORAGE_READ_ONLY'});await assert.rejects(serveOrbitStorage(store,socket,{}),/already exists/);
  for(const part of restored.parts){const result=await verifySelectedPart({context,part:part.part,service:'0x'+'3'.repeat(40),timestamp:Date.now().toString()},{context,part,contentId:id,authorizedAtBlock:1},{fingerprint,evidence:part.evidence,blockNumber:1},pair.privateKey);assert.equal(result.verified,true);}
 }finally{await owner?.close();await runtime?.close();await rm(root,{recursive:true,force:true});}
});
