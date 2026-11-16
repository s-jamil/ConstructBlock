import {createServer,type Server} from 'node:net';
import {mkdir,lstat,chmod,unlink} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {ApiError} from './errors.ts';
import {MAX_BUNDLE_BYTES} from './bid-protocol.ts';
import {validContentId,type CiphertextStore} from './ciphertext-store.ts';

export async function executeOrbitRequest(store:CiphertextStore,request:unknown,info:Record<string,unknown>){
 if(!request||typeof request!=='object'||Array.isArray(request))throw new ApiError(400,'INVALID_PACKAGE','Invalid encrypted storage request.');
 const r=request as Record<string,unknown>,keys=Object.keys(r).sort().join(',');
 if(r.op==='info'&&keys==='op')return info;
 if(r.op==='ids'&&keys==='op')return store.ids();
 if(r.op==='get'&&keys==='contentId,op'&&validContentId(r.contentId))return await store.get(r.contentId)??null;
 if(r.op==='put'&&keys==='contentId,op,serialized'&&validContentId(r.contentId)&&typeof r.serialized==='string'&&Buffer.byteLength(r.serialized)<=MAX_BUNDLE_BYTES){await store.put(r.contentId,r.serialized);return r.contentId;}
 throw new ApiError(400,'INVALID_PACKAGE','Invalid encrypted storage request.');
}

export async function serveOrbitStorage(store:CiphertextStore,socketPath:string,info:Record<string,unknown>):Promise<{server:Server;close():Promise<void>}>{
 if(!isAbsolute(socketPath)||Buffer.byteLength(socketPath)>100)throw new Error('ORBITDB_SOCKET must be an absolute Unix socket path of at most 100 bytes.');
 await mkdir(dirname(socketPath),{recursive:true,mode:0o700});
 // Never unlink an existing socket: another owner may be running. After a crash,
 // an operator must confirm it is stale and remove it deliberately.
 try{await lstat(socketPath);throw new Error('OrbitDB socket already exists. Stop its owner or reconcile the stale socket before restarting.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const sockets=new Set<import('node:net').Socket>();
 const inflight=new Set<Promise<void>>();
 const server=createServer(socket=>{
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.setTimeout(30000,()=>socket.destroy());
  let pending=Buffer.alloc(0),handled=false;
  socket.on('error',()=>{});
  const respond=(value:unknown)=>{if(!socket.destroyed)socket.end(JSON.stringify(value)+'\n');};
  socket.on('data',(chunk:Buffer)=>{
   if(handled)return;pending=Buffer.concat([pending,chunk]);
   // JSON-escaped canonical bundles are larger than their encoded payloads.
   if(pending.length>MAX_BUNDLE_BYTES*2){handled=true;socket.destroy();return;}
   const end=pending.indexOf(10);if(end<0)return;handled=true;
   const operation=(async()=>{
    try{
     if(end!==pending.length-1)throw new Error('Multiple requests are not allowed.');
     const request=JSON.parse(pending.subarray(0,end).toString('utf8'));pending=Buffer.alloc(0);
     const value=await executeOrbitRequest(store,request,info);
     respond({ok:true,value});
    }catch(e){respond({ok:false,error:e instanceof ApiError?{status:e.status,code:e.code}:{status:503,code:'ORBITDB_UNAVAILABLE'}});}
   })();inflight.add(operation);void operation.finally(()=>inflight.delete(operation));
  });
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{server.removeListener('error',reject);resolve();});});
 try{await chmod(socketPath,0o600);}catch(e){await new Promise<void>(resolve=>server.close(()=>resolve()));await unlink(socketPath).catch(()=>{});throw e;}
 return {server,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await Promise.allSettled(inflight);await unlink(socketPath).catch(e=>{if(e.code!=='ENOENT')throw e;});}};
}
