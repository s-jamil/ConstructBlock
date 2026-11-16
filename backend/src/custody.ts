// Operator/view-service only. Never import into the public API or browser.
import {readFile,open} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {createPublicKey,type KeyObject} from 'node:crypto';
import {resolve} from 'node:path';
import {sha,unbase64} from './bid-protocol.ts';
import {loadOpeningKey} from './opening-worker.ts';
import {ApiError} from './errors.ts';
export type CustodyKey={fingerprint:string;unwrap:(wrapped:Uint8Array)=>Promise<Buffer>};
export type KeyLoader=(part:number,fingerprint:string)=>Promise<KeyObject|CustodyKey>;
const unavailable=()=>new ApiError(503,'CUSTODY_KEY_UNAVAILABLE','Custody service unavailable or key policy/fingerprint mismatch. No document or verification outcome was released.');
export async function privateFile(path:string,maxBytes=16384){
 let f;
 try{f=await open(path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);const s=await f.stat();
  if(!s.isFile()||s.size>maxBytes||(s.mode&0o077)!==0)throw unavailable();return await f.readFile();
 }catch{throw unavailable();}finally{await f?.close();}
}
export type VaultMapping={fingerprint:string;name:string;version:number};
export function vaultLoader(options:{address:string;mount:string;tokenFile:string;keys:VaultMapping[];fetch?:typeof fetch}):KeyLoader{
 const url=new URL(options.address);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!options.tokenFile||!/^[-a-zA-Z0-9_]+$/.test(options.mount))throw new Error('Vault requires an HTTPS origin, token file and single mount name.');
 if(!Array.isArray(options.keys)||!options.keys.length||options.keys.some(k=>!/^0x[0-9a-f]{64}$/.test(k.fingerprint)||!/^[-a-zA-Z0-9_]+$/.test(k.name)||!Number.isSafeInteger(k.version)||k.version<1)||new Set(options.keys.map(k=>k.fingerprint)).size!==options.keys.length)throw new Error('Invalid Vault key manifest.');
 const request=async(path:string,body?:unknown)=>{
  let token:Buffer|undefined;
  try{token=await privateFile(options.tokenFile,4096);const credential=token.toString('utf8').trim();if(!credential||/[\r\n]/.test(credential))throw unavailable();
   const response=await(options.fetch??fetch)(new URL(`/v1/${options.mount}/${path}`,url),{method:body?'POST':'GET',redirect:'error',headers:{'X-Vault-Token':credential,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
   // Do not map remote failures to bidder fault or expose Vault responses/tokens.
   if(!response.ok)throw unavailable();
   const raw=await response.text();if(raw.length>65536)throw unavailable();return JSON.parse(raw).data;
  }catch{throw unavailable();}finally{token?.fill(0);}
 };
 return async(_part,fingerprint)=>{
  const binding=options.keys.find(k=>k.fingerprint===fingerprint);if(!binding)throw unavailable();
  const key=await request(`keys/${binding.name}`);
  try{if(key.type!=='rsa-3072'||key.exportable!==false||key.allow_plaintext_backup!==false)throw unavailable();
   const publicKey=createPublicKey(key.keys[String(binding.version)].public_key);
   const der=new Uint8Array(publicKey.export({type:'spki',format:'der'}));
   if(publicKey.asymmetricKeyDetails?.modulusLength!==3072||await sha(der)!==fingerprint)throw unavailable();
  }catch{throw unavailable();}
  return {fingerprint,unwrap:async wrapped=>{
   if(wrapped.length!==384)throw unavailable();
   const data=await request(`decrypt/${binding.name}`,{ciphertext:`vault:v${binding.version}:${Buffer.from(wrapped).toString('base64')}`,padding_scheme:'oaep',hash_algorithm:'sha2-256'});
   try{const material=Buffer.from(unbase64(data.plaintext));if(material.length!==64){material.fill(0);throw unavailable();}return material;}catch{throw unavailable();}
  }};
 };
}
export async function configuredKeyLoader(env:NodeJS.ProcessEnv=process.env):Promise<KeyLoader>{
 if(env.CUSTODY_PROVIDER==='local'){
  if(env.CHAIN_ID!=='31337'||env.NODE_ENV==='production'||!env.CUSTODY_DIR)throw new Error('File custody is permitted only with CHAIN_ID=31337 outside production and an explicit CUSTODY_DIR.');
  const directory=resolve(env.CUSTODY_DIR);return(part,fingerprint)=>loadOpeningKey(directory,part,fingerprint);
 }
 if(env.CUSTODY_PROVIDER==='vault'){
  if(!env.VAULT_KEY_MANIFEST||!env.VAULT_TOKEN_FILE||!env.VAULT_ADDR)throw new Error('Configure VAULT_ADDR, VAULT_TOKEN_FILE and VAULT_KEY_MANIFEST.');
  const keys=JSON.parse(await readFile(env.VAULT_KEY_MANIFEST,'utf8'));
  return vaultLoader({address:env.VAULT_ADDR,mount:env.VAULT_TRANSIT_MOUNT??'transit',tokenFile:env.VAULT_TOKEN_FILE,keys});
 }
 throw new Error('Set CUSTODY_PROVIDER explicitly to local or vault. There is no key-file fallback.');
}
