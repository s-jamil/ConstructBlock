import { BrowserProvider,Contract,Interface,getAddress,id,ZeroHash } from 'ethers';
import artifact from '../../backend/src/abi/ProcurementWorkflow.json' with { type: 'json' };
import type {ChainStatus} from './api.ts';
import type {WalletProvider} from './publication.ts';
import {bytes,canonicalBundle,sha,storageMessage,unbase64,validateBundle,type BidBundle,type BidContext,type Evidence} from '../../backend/src/bid-protocol.ts';
export {encryptPart,canonicalBundle,base64,unbase64,PROTOCOL,MAX_FILE_BYTES} from '../../backend/src/bid-protocol.ts';
export type {BidBundle,BidContext} from '../../backend/src/bid-protocol.ts';
export type BidSession={account:string;deployment:ChainStatus;context:BidContext;fingerprints:string[];requiresTechnicalOffer:boolean;active:boolean;deadline:string};
export type BidTransaction={hash:string;context:BidContext;evidence:Evidence[]};
const abi=new Interface(artifact.abi);
const registryAbi=['function hasRole(bytes32,address) view returns(bool)'];
const zero={commitment:ZeroHash,ciphertextHash:ZeroHash,wrappedPackageHash:ZeroHash};
function provider(wallet:WalletProvider){return new BrowserProvider(wallet,'any',{cacheTimeout:-1});}
export async function checkWallet(wallet:WalletProvider,deployment:ChainStatus,account?:string) {
 const chain=await wallet.request({method:'eth_chainId'});
 if(typeof chain!=='string'||!/^0x[0-9a-f]+$/i.test(chain)||BigInt(chain).toString()!==deployment.chainId)throw new Error(`Switch wallet to chain ${deployment.chainId}.`);
 if(account){const accounts=await wallet.request({method:'eth_accounts'});if(!Array.isArray(accounts)||getAddress(accounts[0])!==getAddress(account))throw new Error('Wallet account changed. Reconnect and prepare again.');}
}
export async function loadBidSession(wallet:WalletProvider,deployment:ChainStatus,tenderId:string,connect=true):Promise<BidSession> {
 if(!/^[1-9][0-9]{0,77}$/.test(tenderId)||BigInt(tenderId)>=2n**256n)throw new Error('Enter a positive uint256 tender ID.');
 const accounts=await wallet.request({method:connect?'eth_requestAccounts':'eth_accounts'});
 if(!Array.isArray(accounts)||!accounts[0])throw new Error('Select a bidder wallet.');
 const account=getAddress(accounts[0]);await checkWallet(wallet,deployment,account);
 const p=provider(wallet);
 try {
  const [rc,wc,block]=await Promise.all([p.getCode(deployment.contracts.roleRegistry),p.getCode(deployment.contracts.procurementWorkflow),p.getBlock('latest')]);
  if(rc==='0x'||wc==='0x'||!block)throw new Error('Configured contracts are missing on the wallet network.');
  const registry=new Contract(deployment.contracts.roleRegistry,registryAbi,p),workflow=new Contract(deployment.contracts.procurementWorkflow,artifact.abi,p);
  if(getAddress(await workflow.registry())!==getAddress(deployment.contracts.roleRegistry))throw new Error('Wallet deployment has a different registry.');
  if(!await registry.hasRole(id('BIDDER_ROLE'),account))throw new Error('This wallet does not hold BIDDER_ROLE.');
  const [t,b,paused,events]=await Promise.all([workflow.getTender(tenderId),workflow.getBid(tenderId,account),workflow.paused(),workflow.queryFilter(workflow.filters.TenderPublished(tenderId),0,block.number)]);
  if(paused||Number(t.state)!==0||BigInt(t.deadline)<=BigInt(block.timestamp))throw new Error('The tender is not accepting bids.');
  if(events.length!==1||!('args' in events[0]))throw new Error('Cannot verify published opening key fingerprints.');
  const version=BigInt(b.version)+1n;if(version>=2n**64n)throw new Error('Bid version limit reached.');
  await checkWallet(wallet,deployment,account);
  return {account,deployment,context:{chainId:deployment.chainId,workflow:deployment.contracts.procurementWorkflow.toLowerCase(),tenderId,bidder:account.toLowerCase(),version:version.toString()},fingerprints:Array.from(events[0].args.openingKeyFingerprints as string[]).map(x=>x.toLowerCase()),requiresTechnicalOffer:Boolean(t.requiresTechnicalOffer),active:Boolean(b.active),deadline:t.deadline.toString()};
 }finally{p.destroy();}
}
export async function apiJson(path:string,body?:unknown,headers:Record<string,string>={}) {
 const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',signal:AbortSignal.timeout(30000)});
 const value=await response.json();if(!response.ok)throw new Error(value?.error?.message??'Storage request failed.');return value;
}
export async function openingKey(fingerprint:string):Promise<Uint8Array> {
 const value=await apiJson('/api/opening-keys/'+fingerprint);
 if(value?.fingerprint!==fingerprint||typeof value.spki!=='string')throw new Error('Invalid opening key response.');
 const der=unbase64(value.spki);if(await sha(der)!==fingerprint)throw new Error('Public opening key fingerprint mismatch.');return der;
}
async function fresh(wallet:WalletProvider,session:BidSession,bundle:BidBundle,isCurrent:()=>boolean){
 if(!isCurrent())throw new Error('Wallet or form changed. Reconnect and prepare again.');
 const current=await loadBidSession(wallet,session.deployment,session.context.tenderId,false);
 if(JSON.stringify(current.context)!==JSON.stringify(bundle.context)||current.requiresTechnicalOffer!==(bundle.parts.length===3)||bundle.parts.some(p=>p.keyFingerprint!==current.fingerprints[p.part]))throw new Error('Bid version or tender configuration changed. Prepare again.');
 if(!isCurrent())throw new Error('Wallet or form changed. Reconnect and prepare again.');
}
export async function uploadBid(wallet:WalletProvider,session:BidSession,bundle:BidBundle,isCurrent=()=>true) {
 await validateBundle(bundle);await fresh(wallet,session,bundle,isCurrent);
 const contentId=await sha(bytes(canonicalBundle(bundle))),timestamp=Date.now().toString(),p=provider(wallet);
 try {
  const signature=await (await p.getSigner(session.account)).signMessage(storageMessage('upload',bundle.context,contentId,timestamp));
  await checkWallet(wallet,session.deployment,session.account);if(!isCurrent())throw new Error('Wallet or form changed. Upload cancelled.');
  const result=await apiJson('/api/storage/bids',bundle,{'X-Storage-Timestamp':timestamp,'X-Storage-Signature':signature});
  if(result?.contentId!==contentId||result.stored!==true||result.acceptedOnChain!==false)throw new Error('Unexpected storage receipt. Do not submit until the package is verified.');
  return contentId;
 }finally{p.destroy();}
}
export async function submitEncryptedBid(wallet:WalletProvider,session:BidSession,bundle:BidBundle,contentId:string,isCurrent=()=>true):Promise<BidTransaction> {
 await validateBundle(bundle);if(await sha(bytes(canonicalBundle(bundle)))!==contentId)throw new Error('Package differs from the stored upload.');
 await fresh(wallet,session,bundle,isCurrent);
 const p=provider(wallet);
 try{
  const workflow=new Contract(session.deployment.contracts.procurementWorkflow,artifact.abi,await p.getSigner(session.account));
  const evidence=[0,1,2].map(part=>bundle.parts.find(p=>p.part===part)?.evidence??zero);
  const args=[bundle.context.tenderId,bundle.context.version,...evidence];
  await workflow.submitBid.staticCall(...args);const gas=await workflow.submitBid.estimateGas(...args);
  await checkWallet(wallet,session.deployment,session.account);if(!isCurrent())throw new Error('Wallet or form changed. Reconnect and review again.');
  const tx=await workflow.submitBid(...args,{gasLimit:gas*120n/100n});
  return {hash:tx.hash,context:bundle.context,evidence};
 }finally{p.destroy();}
}
export async function confirmBid(wallet:WalletProvider,tx:BidTransaction) {
 const chain=await wallet.request({method:'eth_chainId'});
 if(typeof chain!=='string'||BigInt(chain).toString()!==tx.context.chainId)throw new Error(`Switch back to chain ${tx.context.chainId} to check confirmation.`);
 const p=provider(wallet);
 try{
  const receipt=await p.getTransactionReceipt(tx.hash);if(!receipt)return null;
  if(receipt.status!==1)throw new Error('The bid transaction reverted. No bid was accepted by this transaction.');
  const events=receipt.logs.filter(l=>l.address.toLowerCase()===tx.context.workflow).flatMap(l=>{try{const e=abi.parseLog(l);return e?.name==='BidSubmitted'?[e]:[];}catch{return [];}}).filter(e=>e.args.tenderId.toString()===tx.context.tenderId&&e.args.bidder.toLowerCase()===tx.context.bidder&&e.args.version.toString()===tx.context.version&&['initialPart','technicalPart','financialPart'].every((name,i)=>['commitment','ciphertextHash','wrappedPackageHash'].every(field=>e.args[name][field].toLowerCase()===tx.evidence[i][field as keyof Evidence])));
  if(events.length!==1)throw new Error('Receipt does not contain the expected bid evidence. Inspect the transaction before retrying.');
  return {blockNumber:receipt.blockNumber,hash:receipt.hash};
 }finally{p.destroy();}
}
export async function retrieveBid(wallet:WalletProvider,deployment:ChainStatus,bundle:BidBundle,contentId:string) {
 await checkWallet(wallet,deployment,bundle.context.bidder);
 const timestamp=Date.now().toString(),p=provider(wallet);
 try{
  const signature=await (await p.getSigner(bundle.context.bidder)).signMessage(storageMessage('download',bundle.context,contentId,timestamp));
  const value=await apiJson(`/api/storage/${contentId}/retrieve`,bundle.context,{'X-Storage-Timestamp':timestamp,'X-Storage-Signature':signature});
  const stored=await validateBundle(value);if(await sha(bytes(canonicalBundle(stored)))!==contentId)throw new Error('Stored package failed integrity verification.');return stored;
 }finally{p.destroy();}
}
