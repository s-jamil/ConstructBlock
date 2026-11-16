import { readFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createPublicKey } from 'node:crypto';
import { FilesystemCiphertextStore,type CiphertextStore } from './ciphertext-store.ts';
import { verifyMessage,getAddress } from 'ethers';
import { ApiError } from './errors.ts';
import { bytes,canonicalBundle,sha,storageMessage,unbase64,validateBundle,type BidBundle,type BidContext, MAX_BUNDLE_BYTES } from './bid-protocol.ts';
import {openingMessage,validateOpeningRequest} from './opening-protocol.ts';
import type { BlockchainService } from './blockchain.ts';
export type StorageChain = Pick<BlockchainService,'status'|'bidderStatus'|'bidAccess'>;
const fail=(status:number,code:string,message:string):never=>{throw new ApiError(status,code,message);};
export class EncryptedStorage {
 readonly root:string; readonly keyRoot:string; readonly chain:StorageChain;
 private queue:Promise<unknown>=Promise.resolve();
 readonly objects:CiphertextStore;
 constructor(chain:StorageChain,root=resolve('storage'),keyRoot=resolve('opening-keys'),quota=256*1024*1024,objects?:CiphertextStore) {
  this.chain=chain;this.root=resolve(root);this.keyRoot=resolve(keyRoot);this.objects=objects??new FilesystemCiphertextStore(this.root,quota);
 }
 async publicKey(fingerprint:string) {
  if (!/^0x[0-9a-f]{64}$/.test(fingerprint)) return fail(400,'INVALID_FINGERPRINT','Invalid key fingerprint.');
  let value:{fingerprint:string;spki:string};
  try {value=JSON.parse(await readFile(join(this.keyRoot,fingerprint+'.json'),'utf8'));}
  catch(error) {if ((error as NodeJS.ErrnoException).code==='ENOENT')return fail(404,'KEY_NOT_FOUND','No public opening key matches this fingerprint.');throw error;}
  const der=unbase64(value.spki),key=createPublicKey({key:Buffer.from(der),format:'der',type:'spki'});
  if (value.fingerprint!==fingerprint || await sha(der)!==fingerprint || key.asymmetricKeyType!=='rsa' || key.asymmetricKeyDetails?.modulusLength!==3072)
   return fail(503,'INVALID_OPENING_KEY','Opening public key configuration is invalid.');
  return {fingerprint,spki:value.spki};
 }
 private async authorize(action:'upload'|'download',c:BidContext,contentId:string,timestamp:string,signature:string) {
  if (!/^0x[0-9a-f]{64}$/.test(contentId) || !/^[0-9]{13}$/.test(timestamp) || Math.abs(Date.now()-Number(timestamp))>300000)
   return fail(401,'EXPIRED_AUTHORIZATION','Storage authorization must be signed within five minutes.');
  try {if (getAddress(verifyMessage(storageMessage(action,c,contentId,timestamp),signature))!==getAddress(c.bidder))throw new Error();}
  catch {return fail(401,'INVALID_SIGNATURE','Storage authorization does not match the bidder.');}
  const deployment=await this.chain.status();
  if(c.chainId!==deployment.chainId || c.workflow.toLowerCase()!==deployment.contracts.procurementWorkflow.toLowerCase())
   return fail(409,'DEPLOYMENT_MISMATCH','This package belongs to a different deployment.');
  if (!(await this.chain.bidderStatus(getAddress(c.bidder))).approved)
   return fail(403,'NOT_BIDDER','The wallet no longer holds the bidder role.');
 }
 async upload(value:unknown,timestamp:string,signature:string) {
  let bundle:BidBundle;
  try {bundle=await validateBundle(value);}catch {return fail(400,'INVALID_PACKAGE','Encrypted package schema or hashes are invalid.');}
  const serialized=canonicalBundle(bundle),contentId=await sha(bytes(serialized));
  await this.authorize('upload',bundle.context,contentId,timestamp,signature);
  const access=await this.chain.bidAccess(BigInt(bundle.context.tenderId),getAddress(bundle.context.bidder));
  if (access.paused || access.state!==0 || BigInt(access.deadline)<=BigInt(access.chainTime))
   return fail(409,'SUBMISSIONS_CLOSED','The tender is not accepting uploads.');
  if (BigInt(bundle.context.version)!==BigInt(access.version)+1n)
   return fail(409,'STALE_VERSION','Reload the tender and prepare the next bid version.');
  if (bundle.parts.length!==(access.requiresTechnicalOffer?3:2))return fail(400,'PARTS_MISMATCH','The package does not contain the required tender parts.');
  for (const part of bundle.parts) {
   if (part.keyFingerprint!==access.fingerprints[part.part].toLowerCase())return fail(400,'KEY_MISMATCH','Opening keys do not match the published tender.');
   await this.publicKey(part.keyFingerprint);
  }
  const task=this.queue.then(()=>this.persist(contentId,serialized));this.queue=task.catch(()=>{});await task;
  return {contentId,stored:true as const,acceptedOnChain:false as const};
 }
 private async persist(contentId:string,serialized:string) {await this.objects.put(contentId,serialized);}
 async retrieveOpening(value:unknown,signature:string) {
  let request;
  try {request=validateOpeningRequest(value);}catch {return fail(400,'INVALID_OPENING_REQUEST','Supply a valid canonical opening request.');}
  if(Math.abs(Date.now()-Number(request.timestamp))>300000)return fail(401,'EXPIRED_AUTHORIZATION','Opening authorization must be signed within five minutes.');
  try {if(verifyMessage(openingMessage(request),signature).toLowerCase()!==request.service)throw new Error();}
  catch {return fail(401,'INVALID_SIGNATURE','Opening authorization does not match the service wallet.');}
  const chain=this.chain as StorageChain & Partial<Pick<BlockchainService,'openingAccess'>>;
  if(!chain.openingAccess)return fail(503,'OPENING_UNAVAILABLE','Opening access verification is unavailable.');
  const access=await chain.openingAccess(request);
  const result=await this.selectedPart(request.context,request.part,access);
  await chain.openingAccess(request);
  return result;
 }
 // Trusted service primitive, never exposed as an unguarded HTTP route.
 async selectedPart(context:BidContext,selectedPart:number,access:{fingerprint:string;evidence:import('./bid-protocol.ts').Evidence;blockNumber:number}) {
  const matches=[];
  // Discover by immutable context and exact on-chain evidence through the selected store.
  for(const contentId of await this.objects.ids()){
    try {
      const serialized=await this.objects.get(contentId);
      if(serialized===undefined||Buffer.byteLength(serialized)>MAX_BUNDLE_BYTES)continue;
      const raw=JSON.parse(serialized);
      const c=raw?.context,wanted=context;
      if(!c || ['chainId','workflow','tenderId','bidder','version'].some(k=>c[k]!==wanted[k as keyof typeof wanted]))continue;
      const bundle=await validateBundle(raw);
      if(await sha(bytes(canonicalBundle(bundle)))!==contentId)continue;
      const part=bundle.parts.find(p=>p.part===selectedPart);
      if(!part || part.keyFingerprint!==access.fingerprint || ['commitment','ciphertextHash','wrappedPackageHash'].some(k=>part.evidence[k as keyof typeof part.evidence]!==access.evidence[k as keyof typeof access.evidence]))continue;
      matches.push({contentId,context:bundle.context,part,authorizedAtBlock:access.blockNumber});
    }catch(error) { if(error instanceof ApiError&&error.status===503)throw error; /* Corrupt records never become bidder failures. */ }
  }
  if(!matches.length)return fail(404,'OPENING_PACKAGE_MISSING','No intact stored part matches the current on-chain bid evidence. Restore storage before opening.');
  // Several bundles may share the same selected part but differ in other parts; those bytes are identical evidence.
  matches.sort((a,b)=>a.contentId.localeCompare(b.contentId));
  return matches[0];
 }
 async retrieve(contentId:string,context:BidContext,timestamp:string,signature:string) {
  await this.authorize('download',context,contentId,timestamp,signature);
  let raw:string;
  const stored=await this.objects.get(contentId);
  if(stored===undefined)return fail(404,'PACKAGE_NOT_FOUND','No encrypted package was found.');
  raw=stored;
  const bundle=await validateBundle(JSON.parse(raw));
  if (await sha(bytes(canonicalBundle(bundle)))!==contentId)throw new Error('Storage corruption');
  if (JSON.stringify(bundle.context)!==JSON.stringify(context))return fail(403,'NOT_OWNER','This encrypted package belongs to a different context.');
  return bundle;
 }
}
