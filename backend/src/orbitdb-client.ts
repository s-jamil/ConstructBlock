import {createConnection} from 'node:net';
import {isAbsolute,resolve} from 'node:path';
import {ApiError} from './errors.ts';
import {FilesystemCiphertextStore,validContentId,type CiphertextStore} from './ciphertext-store.ts';
import {MAX_BUNDLE_BYTES} from './bid-protocol.ts';
export const defaultOrbitSocket=()=>resolve('orbitdb-data','storage.sock');
const unavailable=()=>new ApiError(503,'ORBITDB_UNAVAILABLE','OrbitDB storage is unavailable. Start the database service and check its socket configuration.');
export class OrbitDbClient implements CiphertextStore {
 readonly socketPath:string;readonly readOnly:boolean;readonly timeout:number;
 constructor(socketPath=defaultOrbitSocket(),readOnly=false,timeout=30000){
  if(!isAbsolute(socketPath)||Buffer.byteLength(socketPath)>100)throw new Error('ORBITDB_SOCKET must be an absolute Unix socket path of at most 100 bytes.');
  this.socketPath=socketPath;this.readOnly=readOnly;this.timeout=timeout;
 }
 private async request(op:string,extra:Record<string,unknown>={}){
  return new Promise<unknown>((resolve,reject)=>{
   const socket=createConnection(this.socketPath);let length=0;const chunks:Buffer[]=[];
   const done=(error?:Error,value?:unknown)=>{socket.removeAllListeners();socket.destroy();error?reject(error):resolve(value);};
   socket.setTimeout(this.timeout,()=>done(unavailable()));socket.once('error',()=>done(unavailable()));
   socket.once('connect',()=>socket.write(JSON.stringify({op,...extra})+'\n'));
   socket.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>MAX_BUNDLE_BYTES+65536)return done(unavailable());chunks.push(chunk);});
   socket.once('end',()=>{
    try{
     const response=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     if(response.ok===true)return done(undefined,response.value);
     const e=response.error;
     if(e&&[400,409,507].includes(e.status)&&['INVALID_CONTENT_ID','INVALID_PACKAGE','STORAGE_CORRUPT','STORAGE_FULL'].includes(e.code))return done(new ApiError(e.status,e.code,'Encrypted database request was rejected.'));
     done(unavailable());
    }catch{done(unavailable());}
   });
  });
 }
 async get(contentId:string){
  if(!validContentId(contentId))throw new ApiError(400,'INVALID_CONTENT_ID','Invalid encrypted content identifier.');
  const value=await this.request('get',{contentId});
  if(value===null)return undefined;if(typeof value!=='string'||Buffer.byteLength(value)>MAX_BUNDLE_BYTES)throw unavailable();return value;
 }
 async ids(){const value=await this.request('ids');if(!Array.isArray(value)||value.length>1000||!value.every(validContentId))throw unavailable();return value as string[];}
 async put(contentId:string,serialized:string){
  if(this.readOnly)throw new ApiError(403,'STORAGE_READ_ONLY','This service has read-only encrypted database access.');
  if(!validContentId(contentId)||typeof serialized!=='string'||Buffer.byteLength(serialized)>MAX_BUNDLE_BYTES)throw new ApiError(400,'INVALID_PACKAGE','Invalid encrypted database package.');
  if(await this.request('put',{contentId,serialized})!==contentId)throw unavailable();
 }
 async info(){return this.request('info');}
}
export function configuredCiphertextStore(env:NodeJS.ProcessEnv=process.env,readOnly=false):CiphertextStore{
 const provider=env.STORAGE_PROVIDER??'filesystem';
 if(provider==='orbitdb')return new OrbitDbClient(env.ORBITDB_SOCKET??defaultOrbitSocket(),readOnly);
 if(provider==='filesystem')return new FilesystemCiphertextStore(resolve(env.STORAGE_DIR??'storage'));
 throw new Error('STORAGE_PROVIDER must be filesystem or orbitdb.');
}
