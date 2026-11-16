// Shared browser/server wire protocol. No filesystem, wallet, or private-key access.
export const PROTOCOL = 'constructBlock-bid-v1';
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_BUNDLE_BYTES = 6 * 1024 * 1024;
export type Evidence = { commitment: string; ciphertextHash: string; wrappedPackageHash: string };
export type BidContext = { chainId: string; workflow: string; tenderId: string; bidder: string; version: string };
export type EncryptedPart = { part: number; keyFingerprint: string; nonce: string; ciphertext: string; wrapped: string; evidence: Evidence };
export type BidBundle = { protocol: typeof PROTOCOL; context: BidContext; parts: EncryptedPart[] };
const utf8 = new TextEncoder();
export const bytes = (s: string) => utf8.encode(s);
export function base64(data: Uint8Array): string {
 let result = ''; for (let i=0;i<data.length;i+=8192) result += String.fromCharCode(...data.subarray(i,i+8192));
 return btoa(result);
}
export function unbase64(s: string): Uint8Array {
 if (typeof s !== 'string' || s.length > MAX_BUNDLE_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) throw new Error('Invalid base64 encoding');
 return Uint8Array.from(atob(s), c=>c.charCodeAt(0));
}
export function concat(...values: Uint8Array[]): Uint8Array {
 const out = new Uint8Array(values.reduce((n,v)=>n+v.length,0)); let offset=0;
 for (const v of values) {out.set(v,offset); offset+=v.length;} return out;
}
export function frame(...values: Uint8Array[]): Uint8Array {
 return concat(...values.flatMap(v=>{const size=new Uint8Array(4);new DataView(size.buffer).setUint32(0,v.length);return [size,v];}));
}
export async function sha(data: Uint8Array): Promise<string> {
 const hash=await crypto.subtle.digest('SHA-256',new Uint8Array(data));
 return '0x'+Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
}
export function contextBytes(c: BidContext, part: number) {
 return bytes(JSON.stringify([PROTOCOL,c.chainId,c.workflow.toLowerCase(),c.tenderId,c.bidder.toLowerCase(),part,c.version]));
}
export function canonicalBundle(b: BidBundle): string {
 const c=b.context;
 return JSON.stringify({protocol:PROTOCOL,context:{chainId:c.chainId,workflow:c.workflow.toLowerCase(),tenderId:c.tenderId,bidder:c.bidder.toLowerCase(),version:c.version},parts:b.parts.map(p=>({part:p.part,keyFingerprint:p.keyFingerprint.toLowerCase(),nonce:p.nonce,ciphertext:p.ciphertext,wrapped:p.wrapped,evidence:{commitment:p.evidence.commitment.toLowerCase(),ciphertextHash:p.evidence.ciphertextHash.toLowerCase(),wrappedPackageHash:p.evidence.wrappedPackageHash.toLowerCase()}}))});
}
export function storageMessage(action:'upload'|'download', c: BidContext, contentId:string, timestamp:string) {
 return ['constructBlock encrypted storage authorization v1',`Action: ${action}`,`Chain: ${c.chainId}`,`Workflow: ${c.workflow.toLowerCase()}`,`Tender: ${c.tenderId}`,`Bidder: ${c.bidder.toLowerCase()}`,`Version: ${c.version}`,`Content SHA-256: ${contentId}`,`Issued at milliseconds: ${timestamp}`,'This authorizes encrypted storage only. It does not submit or accept a bid.'].join('\n');
}
export async function encryptPart(c:BidContext, part:number, file:{name:string;type:string;data:Uint8Array}, spki:Uint8Array, expectedFingerprint:string):Promise<EncryptedPart> {
 if (!file.data.length || file.data.length>MAX_FILE_BYTES) throw new Error('Each bid document must contain 1 byte to 1 MiB.');
 if (file.name.length>255 || file.type.length>128) throw new Error('File metadata is too long.');
 const keyFingerprint=await sha(spki);
 if (keyFingerprint !== expectedFingerprint.toLowerCase()) throw new Error('Opening public key does not match the published fingerprint.');
 const rsa=await crypto.subtle.importKey('spki',new Uint8Array(spki),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
 if ((rsa.algorithm as RsaHashedKeyAlgorithm).modulusLength!==3072) throw new Error('Opening keys must use RSA 3072.');
 const raw=crypto.getRandomValues(new Uint8Array(32)),salt=crypto.getRandomValues(new Uint8Array(32)),nonce=crypto.getRandomValues(new Uint8Array(12));
 const context=contextBytes(c,part), plaintext=bytes(JSON.stringify({name:file.name,type:file.type,data:base64(file.data)}));
 try {
  const aes=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt']);
  // WebCrypto appends the 128-bit GCM tag to the ciphertext.
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:context,tagLength:128},aes,plaintext));
  const wrapped=new Uint8Array(await crypto.subtle.encrypt({name:'RSA-OAEP'},rsa,concat(raw,salt)));
  return {part,keyFingerprint,nonce:base64(nonce),ciphertext:base64(ciphertext),wrapped:base64(wrapped),evidence:{commitment:await sha(frame(context,salt,plaintext)),ciphertextHash:await sha(frame(context,nonce,ciphertext)),wrappedPackageHash:await sha(wrapped)}};
 } finally {raw.fill(0);salt.fill(0);plaintext.fill(0);}
}
export async function validateBundle(value:unknown):Promise<BidBundle> {
 const b=value as BidBundle;
 const integer=(x:unknown,bits:number)=>typeof x==='string' && /^[1-9][0-9]{0,77}$/.test(x) && BigInt(x)<2n**BigInt(bits);
 const address=(x:unknown)=>typeof x==='string' && /^0x[0-9a-f]{40}$/.test(x) && !/^0x0{40}$/.test(x);
 const digest=(x:unknown)=>typeof x==='string' && /^0x[0-9a-f]{64}$/.test(x) && !/^0x0{64}$/.test(x);
 if (!b || b.protocol!==PROTOCOL || !b.context || !integer(b.context.chainId,256)||!integer(b.context.tenderId,256)||!integer(b.context.version,64)||!address(b.context.workflow)||!address(b.context.bidder)||!Array.isArray(b.parts)||![2,3].includes(b.parts.length)) throw new Error('Invalid bid package context.');
 const required=b.parts.length===3?[0,1,2]:[0,2];
 for (let i=0;i<required.length;i++) {
  const p=b.parts[i];
  if (!p || p.part!==required[i] || !digest(p.keyFingerprint)||!p.evidence|| !Object.values(p.evidence).every(digest) || Object.keys(p.evidence).length!==3) throw new Error('Invalid encrypted part evidence.');
  const nonce=unbase64(p.nonce),ciphertext=unbase64(p.ciphertext),wrapped=unbase64(p.wrapped);
  if (nonce.length!==12 || ciphertext.length<17 || ciphertext.length>2*MAX_FILE_BYTES || wrapped.length!==384) throw new Error('Invalid encrypted part size.');
  if (await sha(frame(contextBytes(b.context,p.part),nonce,ciphertext))!==p.evidence.ciphertextHash || await sha(wrapped)!==p.evidence.wrappedPackageHash) throw new Error('Encrypted package hash mismatch.');
 }
 // Reject unknown outer/part fields rather than silently retaining unintended plaintext.
 if (JSON.stringify(JSON.parse(canonicalBundle(b)))!==JSON.stringify(b)) throw new Error('Package must use the canonical schema and field order.');
 if (bytes(canonicalBundle(b)).length>MAX_BUNDLE_BYTES) throw new Error('Bid package exceeds 6 MiB.');
 return b;
}
