import {ApiError} from './errors.ts';
import {isDeepStrictEqual} from 'node:util';
import {validContentId,type CiphertextStore} from './ciphertext-store.ts';
import {bytes,sha,canonicalBundle,validateBundle,PROTOCOL,MAX_BUNDLE_BYTES,type BidBundle} from './bid-protocol.ts';

// The shape returned by OrbitDB 4's Documents API. No OrbitDB runtime is loaded
// into the public API or the key-bearing document service.
export interface OrbitDocuments {
 get(key:string):Promise<{key:string;value:unknown}|undefined>;
 put(document:Record<string,unknown>):Promise<unknown>;
 iterator():AsyncIterable<{key:string;value:unknown}>;
}
const schema='constructBlock-orbitdb-v1';
const corrupt=()=>new ApiError(409,'STORAGE_CORRUPT','Encrypted database records failed integrity verification.');
export class OrbitDbCiphertextStore implements CiphertextStore {
 readonly database:OrbitDocuments;
 readonly quota:number;
 private queue:Promise<unknown>=Promise.resolve();
 constructor(database:OrbitDocuments,quota=256*1024*1024){this.database=database;this.quota=quota;}
 async ids(){
  const ids:string[]=[];
  for await(const {key,value} of this.database.iterator()){
   const v=value as Record<string,unknown>;
   if(v?.schema===schema&&v.kind==='bundle'&&validContentId(key)&&v._id===key)ids.push(key);
   if(ids.length>1000)throw new ApiError(503,'STORAGE_LIMIT','Database exceeds the configured package limit.');
  }
  return ids.sort();
 }
 async get(contentId:string){
  if(!validContentId(contentId))throw new ApiError(400,'INVALID_CONTENT_ID','Invalid encrypted content identifier.');
  const entry=await this.database.get(contentId);if(!entry)return undefined;
  const manifest=entry.value as Record<string,unknown>;
  if(entry.key!==contentId||manifest?.schema!==schema||manifest.kind!=='bundle'||manifest._id!==contentId||!Array.isArray(manifest.parts)||![2,3].includes(manifest.parts.length))throw corrupt();
  const parts=[];
  for(const number of manifest.parts){
   if(!Number.isInteger(number)||number<0||number>2)throw corrupt();
   const key=contentId+':'+number,part=await this.database.get(key),v=part?.value as Record<string,unknown>|undefined;
   if(part?.key!==key||v?.schema!==schema||v.kind!=='part'||v._id!==key||v.contentId!==contentId||!isDeepStrictEqual(v.context,manifest.context))throw corrupt();
   parts.push(v.part);
  }
  let serialized:string;
  try{
   const candidate={protocol:PROTOCOL,context:manifest.context,parts};
   serialized=canonicalBundle(candidate as BidBundle);
   // DAG-CBOR reorders object keys. Restore wire ordering without dropping
   // unknown fields, then apply the unchanged strict wire-protocol validator.
   const canonical=JSON.parse(serialized);
   if(!isDeepStrictEqual(candidate,canonical))throw corrupt();
   await validateBundle(canonical);
   if(Buffer.byteLength(serialized)>MAX_BUNDLE_BYTES||await sha(bytes(serialized))!==contentId)throw corrupt();
  }catch{throw corrupt();}
  return serialized;
 }
 async put(contentId:string,serialized:string){
  const task=this.queue.then(()=>this.persist(contentId,serialized));this.queue=task.catch(()=>{});return task;
 }
 private async persist(contentId:string,serialized:string){
  if(!validContentId(contentId)||Buffer.byteLength(serialized)>MAX_BUNDLE_BYTES)throw new ApiError(400,'INVALID_PACKAGE','Invalid encrypted database package.');
  let bundle:BidBundle;
  try{bundle=await validateBundle(JSON.parse(serialized));}catch{throw new ApiError(400,'INVALID_PACKAGE','Invalid encrypted database package.');}
  if(canonicalBundle(bundle)!==serialized||await sha(bytes(serialized))!==contentId)throw new ApiError(400,'INVALID_PACKAGE','Encrypted package does not match its content identifier.');
  const existing=await this.get(contentId);
  if(existing!==undefined){if(existing!==serialized)throw corrupt();return;}
  // Actual ciphertext lives in part documents. The final bundle document is a
  // commit marker: interrupted writes are never listed as accepted packages.
  const records:Record<string,unknown>[]=[...bundle.parts.map(part=>({_id:contentId+':'+part.part,schema,kind:'part',contentId,context:bundle.context,part})),{_id:contentId,schema,kind:'bundle',context:bundle.context,parts:bundle.parts.map(p=>p.part)}];
  const missing=[];
  for(const record of records){
   const entry=await this.database.get(record._id as string);
   if(entry){if(!isDeepStrictEqual(entry.value,record))throw corrupt();}
   else missing.push(record);
  }
  let size=0,count=0,recordCount=0;
  for await(const {value} of this.database.iterator()){
   if(++recordCount>4000)throw new ApiError(507,'STORAGE_FULL','Encrypted database record limit reached.');
   size+=Buffer.byteLength(JSON.stringify(value));
   if((value as Record<string,unknown>)?.kind==='bundle')count++;
  }
  if(count>=1000||size+missing.reduce((sum,v)=>sum+Buffer.byteLength(JSON.stringify(v)),0)>this.quota)throw new ApiError(507,'STORAGE_FULL','Encrypted database quota reached.');
  for(const record of missing)await this.database.put(record);
  if(await this.get(contentId)!==serialized)throw corrupt();
 }
}
