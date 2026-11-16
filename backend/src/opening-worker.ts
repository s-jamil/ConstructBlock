// Private operator/document service module: never imported by the public API or frontend.
import {open} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {join} from 'node:path';
import {createPrivateKey,createPublicKey,privateDecrypt,createDecipheriv,constants,type KeyObject} from 'node:crypto';
import {Contract,type Signer} from 'ethers';
import workflowArtifact from './abi/ProcurementWorkflow.json' with {type:'json'};
import {ApiError} from './errors.ts';
import {MAX_FILE_BYTES,bytes,contextBytes,frame,sha,unbase64,type EncryptedPart,type BidContext} from './bid-protocol.ts';
import {openingMessage,validateOpeningRequest,type OpeningRequest,type OpeningEvidence} from './opening-protocol.ts';
import type {CustodyKey} from './custody.ts';
import type {BlockchainService} from './blockchain.ts';
export type SelectedOpeningPart={contentId:string;context:BidContext;part:EncryptedPart;authorizedAtBlock:number};
export type Verification={verified:boolean;code:'VERIFIED'|'WRAPPED_KEY_INVALID'|'AUTHENTICATION_FAILED'|'COMMITMENT_MISMATCH'|'DOCUMENT_INVALID'};
export async function loadOpeningKey(directory:string,part:number,expectedFingerprint:string):Promise<KeyObject>{
 const name=['initial','technical','financial'][part];if(!name)throw new Error('Invalid part.');
 let pem:Buffer|undefined,file;
 try{
  const path=join(directory,name+'.pem');file=await open(path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);const metadata=await file.stat();
  if(!metadata.isFile()||metadata.size>16384||(metadata.mode&0o077)!==0)throw new Error();
  pem=await file.readFile();const key=createPrivateKey(pem),publicKey=createPublicKey(key);
  if(publicKey.asymmetricKeyType!=='rsa'||publicKey.asymmetricKeyDetails?.modulusLength!==3072||await sha(new Uint8Array(publicKey.export({type:'spki',format:'der'})))!==expectedFingerprint)throw new Error();
  return key;
 }catch{throw new ApiError(503,'CUSTODY_KEY_UNAVAILABLE','The selected private opening key is missing, has unsafe permissions, or does not match the published fingerprint. No outcome was recorded.');}
 finally{pem?.fill(0);await file?.close();}
}
export async function verifySelectedPart(request:OpeningRequest,value:SelectedOpeningPart,access:OpeningEvidence,key:KeyObject|CustodyKey,onDocument?:(doc:{name:string;type:string;data:Uint8Array})=>void):Promise<Verification>{
 const part=value?.part;
 if(!part||part.part!==request.part||JSON.stringify(value.context)!==JSON.stringify(request.context)||part.keyFingerprint!==access.fingerprint
  || !part.evidence||['commitment','ciphertextHash','wrappedPackageHash'].some(k=>part.evidence[k as keyof typeof part.evidence]!==access.evidence[k as keyof typeof access.evidence]))
  throw new ApiError(409,'OPENING_EVIDENCE_MISMATCH','The retrieved part does not match the authorized on-chain evidence.');
 const nonce=unbase64(part.nonce),encrypted=Buffer.from(unbase64(part.ciphertext)),wrapped=unbase64(part.wrapped),context=contextBytes(request.context,request.part);
 if(nonce.length!==12||encrypted.length<17||encrypted.length>2*MAX_FILE_BYTES||wrapped.length!==384
  ||await sha(frame(context,nonce,encrypted))!==access.evidence.ciphertextHash||await sha(wrapped)!==access.evidence.wrappedPackageHash)
  throw new ApiError(409,'OPENING_EVIDENCE_MISMATCH','The retrieved encrypted bytes failed integrity verification.');
 // Do not classify a wrong operator key as bidder failure, even when a custom key loader is used.
 const remote='unwrap' in key;
 if(remote){if(key.fingerprint!==access.fingerprint)throw new ApiError(503,'CUSTODY_KEY_UNAVAILABLE','Custody key fingerprint differs from the authorized key.');}
 else {const publicKey=createPublicKey(key);
 if(publicKey.asymmetricKeyType!=='rsa'||publicKey.asymmetricKeyDetails?.modulusLength!==3072||await sha(new Uint8Array(publicKey.export({type:'spki',format:'der'})))!==access.fingerprint)
  throw new ApiError(503,'CUSTODY_KEY_UNAVAILABLE','The private opening key does not match the authorized fingerprint.');}
 let material:Buffer|undefined,plaintext:Buffer|undefined,partial:Buffer|undefined,file:Uint8Array|undefined;
 try{
  if(remote)material=await key.unwrap(wrapped);
  else try{material=privateDecrypt({key,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},wrapped);}catch{return {verified:false,code:'WRAPPED_KEY_INVALID'};}
  if(material.length!==64)return {verified:false,code:'WRAPPED_KEY_INVALID'};
  try{
   const aes=createDecipheriv('aes-256-gcm',material.subarray(0,32),nonce,{authTagLength:16});aes.setAAD(context);aes.setAuthTag(encrypted.subarray(-16));
   partial=aes.update(encrypted.subarray(0,-16));plaintext=Buffer.concat([partial,aes.final()]);
  }catch{return {verified:false,code:'AUTHENTICATION_FAILED'};}
  if(await sha(frame(context,material.subarray(32),plaintext))!==access.evidence.commitment)return {verified:false,code:'COMMITMENT_MISMATCH'};
  let name='',type='';
  try{
   const doc=JSON.parse(plaintext.toString('utf8'));
   if(!doc||Object.keys(doc).join(',')!=='name,type,data'||typeof doc.name!=='string'||!doc.name.length||doc.name.length>255||typeof doc.type!=='string'||doc.type.length>128)throw new Error();
   file=unbase64(doc.data);if(file.length<1||file.length>MAX_FILE_BYTES)throw new Error();
   if(JSON.stringify(doc)!==plaintext.toString('utf8'))throw new Error();
   name=doc.name;type=doc.type;
  }catch{return {verified:false,code:'DOCUMENT_INVALID'};}
  onDocument?.({name,type,data:file!});
  return {verified:true,code:'VERIFIED'};
 }finally{material?.fill(0);plaintext?.fill(0);partial?.fill(0);file?.fill(0);}
}
export async function processOpening(options:{chain:Pick<BlockchainService,'openingAccess'|'status'>;signer:Signer;request:OpeningRequest;
 retrieve:(request:OpeningRequest,signature:string)=>Promise<SelectedOpeningPart>;
 loadKey:(part:number,fingerprint:string)=>Promise<KeyObject|CustodyKey>;onSubmitted?:(hash:string)=>Promise<void>}) {
 const {chain,signer}=options;const request=validateOpeningRequest(options.request);
 if((await signer.getAddress()).toLowerCase()!==request.service)throw new ApiError(403,'SIGNER_MISMATCH','The signer does not match the requested opening service.');
 if(!signer.provider)throw new Error('Opening signer requires a provider.');
 const status=await chain.status();
 if((await signer.provider.getNetwork()).chainId.toString()!==request.context.chainId||status.chainId!==request.context.chainId||status.contracts.procurementWorkflow.toLowerCase()!==request.context.workflow)
  throw new ApiError(409,'DEPLOYMENT_MISMATCH','Signer and opening API must use the same deployment.');
 const before=await chain.openingAccess(request);
 const selected=await options.retrieve(request,await signer.signMessage(openingMessage(request)));
 const access=await chain.openingAccess(request);
 if(JSON.stringify(access.evidence)!==JSON.stringify(before.evidence)||access.fingerprint!==before.fingerprint)throw new ApiError(409,'OPENING_CHANGED','Opening evidence changed. No result was recorded.');
 // No private key is read until both the worker and the storage API authorize this stage.
 const key=await options.loadKey(request.part,access.fingerprint);
 const verification=await verifySelectedPart(request,selected,access,key);
 await chain.openingAccess(request);
 const attestation={protocol:'constructBlock-opening-result-v1',context:request.context,part:request.part,service:request.service,
  evidence:access.evidence,verified:verification.verified,code:verification.code};
 const resultDigest=await sha(bytes(JSON.stringify(attestation)));
 const workflow=new Contract(request.context.workflow,workflowArtifact.abi,signer);
 const args=[request.context.tenderId,request.context.bidder,request.context.version,request.part,verification.verified,resultDigest];
 await workflow.recordOpeningResult.staticCall(...args);
 if(await signer.getNonce('pending')>await signer.getNonce('latest'))throw new ApiError(409,'PENDING_SERVICE_TRANSACTION','The service wallet has a pending transaction. Reconcile it before recording another result.');
 const tx=await workflow.recordOpeningResult(...args);
 try{await options.onSubmitted?.(tx.hash);}catch{throw new ApiError(503,'OPENING_BROADCAST_NOT_JOURNALED',`Result transaction submitted as ${tx.hash}. Inspect it before retrying.`);}
 const report={...attestation,resultDigest,transactionHash:tx.hash};
 let receipt;
 try{receipt=await tx.wait(1,30000);}catch(e){
  if((e as {code?:string}).code==='TIMEOUT')return {...report,status:'pending' as const};
  throw new ApiError(409,'OPENING_TRANSACTION_UNCONFIRMED',`Inspect result transaction ${tx.hash} before retrying.`);
 }
 if(!receipt||receipt.status!==1)throw new ApiError(409,'OPENING_TRANSACTION_REVERTED',`Result transaction ${tx.hash} reverted. No successful opening result was confirmed.`);
 const matches=receipt.logs.flatMap((log:{address:string;topics:readonly string[];data:string})=>{if(log.address.toLowerCase()!==request.context.workflow)return [];try{const e=workflow.interface.parseLog(log);return e?.name==='OpeningResult'?[e]:[];}catch{return [];}}).filter((e:{args:any})=>e.args.tenderId.toString()===request.context.tenderId&&e.args.bidder.toLowerCase()===request.context.bidder&&e.args.version.toString()===request.context.version&&Number(e.args.part)===request.part&&Number(e.args.outcome)===(verification.verified?1:2)&&e.args.resultDigest===resultDigest&&e.args.service.toLowerCase()===request.service);
 if(matches.length!==1)throw new ApiError(409,'OPENING_RECEIPT_MISMATCH',`Result receipt ${tx.hash} lacks the expected event. Inspect it before retrying.`);
 return {...report,status:'confirmed' as const,blockNumber:receipt.blockNumber};
}
