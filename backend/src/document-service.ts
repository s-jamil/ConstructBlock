// Private service only: public server.ts must never import this module.
import {mkdir,open,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {verifyMessage} from 'ethers';
import {ApiError} from './errors.ts';
import {bytes,sha,base64} from './bid-protocol.ts';
import {validateDocumentRequest,documentMessage} from './document-protocol.ts';
import {verifySelectedPart} from './opening-worker.ts';
import type {BlockchainService} from './blockchain.ts';
import type {EncryptedStorage} from './storage.ts';
import type {KeyLoader} from './custody.ts';
export class DocumentService{
 readonly chain:Pick<BlockchainService,'documentAccess'>;readonly storage:Pick<EncryptedStorage,'selectedPart'>;readonly loadKey:KeyLoader;readonly auditRoot:string;
 constructor(chain:Pick<BlockchainService,'documentAccess'>,storage:Pick<EncryptedStorage,'selectedPart'>,loadKey:KeyLoader,auditRoot:string){this.chain=chain;this.storage=storage;this.loadKey=loadKey;this.auditRoot=auditRoot;}
 async view(value:unknown,signature:string){
  let request;try{request=validateDocumentRequest(value);}catch{throw new ApiError(400,'INVALID_DOCUMENT_REQUEST','Supply a canonical document request with a single-use nonce.');}
  const timestamp=Number(request.timestamp);
  if(Date.now()-timestamp>60000||timestamp-Date.now()>5000)throw new ApiError(401,'EXPIRED_AUTHORIZATION','Sign a fresh document request within one minute.');
  try{if(verifyMessage(documentMessage(request),signature).toLowerCase()!==request.viewer)throw new Error();}
  catch{throw new ApiError(401,'INVALID_SIGNATURE','Document authorization does not match the viewer.');}
  // A durable exclusive reservation consumes a signed request across workers/restarts.
  const id=await sha(bytes(request.viewer+request.nonce)),root=resolve(this.auditRoot);
  let audit;
  const auditUnavailable=()=>new ApiError(503,'AUDIT_UNAVAILABLE','Document access audit is unavailable. No document was released.');
  try{await mkdir(root,{recursive:true,mode:0o700});if((await readdir(root)).length>=10000)throw auditUnavailable();}
  catch{throw auditUnavailable();}
  try{audit=await open(join(root,id+'.jsonl'),'wx',0o600);}
  catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new ApiError(409,'DOCUMENT_REQUEST_REPLAYED','This authorization has already been used. Sign a fresh request.');throw auditUnavailable();}

  let doc:{name:string;type:string;data:Uint8Array}|undefined;
  const record=async(status:string,extra:Record<string,unknown>={})=>{
   try{await audit.writeFile(JSON.stringify({protocol:'constructBlock-document-audit-v1',requestId:id,request,status,recordedAt:new Date().toISOString(),...extra})+'\n');await audit.sync();}
   catch{throw new ApiError(503,'AUDIT_UNAVAILABLE','Document access could not be audited. No document was released.');}
  };
  try{
   await record('requested');
   const before=await this.chain.documentAccess(request);
   const selected=await this.storage.selectedPart(request.context,request.part,before);
   const access=await this.chain.documentAccess(request);
   if(access.fingerprint!==before.fingerprint||JSON.stringify(access.evidence)!==JSON.stringify(before.evidence))throw new ApiError(409,'DOCUMENT_CHANGED','Document evidence changed. Reload before viewing.');
   const key=await this.loadKey(request.part,access.fingerprint);
   const opening={context:request.context,part:request.part,service:request.viewer,timestamp:request.timestamp};
   const result=await verifySelectedPart(opening,selected,access,key,d=>{doc={name:d.name,type:d.type,data:new Uint8Array(d.data)};});
   if(!result.verified||!doc)throw new ApiError(409,'DOCUMENT_INTEGRITY_FAILED','The document failed verification. No contents were released.');
   const after=await this.chain.documentAccess(request);
   if(after.fingerprint!==access.fingerprint||JSON.stringify(after.evidence)!==JSON.stringify(access.evidence))throw new ApiError(409,'DOCUMENT_CHANGED','Document evidence changed before release.');
   if(Date.now()-timestamp>60000)throw new ApiError(401,'EXPIRED_AUTHORIZATION','Document authorization expired before release. Sign a fresh request.');
   await record('release-authorized',{authorizedAtBlock:after.blockNumber,contentId:selected.contentId});
   return {requestId:id,context:request.context,part:request.part,authorizedAtBlock:after.blockNumber,document:{name:doc.name,type:doc.type,data:base64(doc.data)}};
  }catch(error){await record('denied',{code:error instanceof ApiError?error.code:'DOCUMENT_SERVICE_FAILED'});throw error;}
  finally{doc?.data.fill(0);await audit.close();}
 }
}
