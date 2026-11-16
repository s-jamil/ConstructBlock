import {BrowserProvider,getAddress} from 'ethers';
import type {WalletProvider} from './publication.ts';
import type {GovernanceSnapshot} from './governance-client.ts';
import {documentMessage,validateDocumentRequest,type DocumentRequest} from '../../backend/src/document-protocol.ts';
import {unbase64,MAX_FILE_BYTES} from '../../backend/src/bid-protocol.ts';
export type ViewedDocument={requestId:string;name:string;type:string;data:Uint8Array;blockNumber:number};
async function currentWallet(wallet:WalletProvider,s:GovernanceSnapshot){
 const chain=await wallet.request({method:'eth_chainId'}),accounts=await wallet.request({method:'eth_accounts'});
 if(typeof chain!=='string'||!/^0x[0-9a-f]+$/i.test(chain)||BigInt(chain).toString()!==s.deployment.chainId||!Array.isArray(accounts)||!accounts[0]||getAddress(accounts[0])!==getAddress(s.account))throw new Error('Wallet changed. Reload the tender before viewing.');
}
export function parseDocument(value:unknown,request:DocumentRequest):ViewedDocument{
 const v=value as {requestId:string;context:DocumentRequest['context'];part:number;authorizedAtBlock:number;document:{name:string;type:string;data:string}};
 if(!v||!/^0x[0-9a-f]{64}$/.test(v.requestId)||!v.context||['chainId','workflow','tenderId','bidder','version'].some(k=>v.context[k as keyof typeof v.context]!==request.context[k as keyof typeof request.context])||v.part!==request.part||!Number.isSafeInteger(v.authorizedAtBlock)||v.authorizedAtBlock<0||!v.document||typeof v.document.name!=='string'||v.document.name.length<1||v.document.name.length>255||typeof v.document.type!=='string'||v.document.type.length>128)throw new Error('Document response does not match the signed request.');
 const data=unbase64(v.document.data);if(!data.length||data.length>MAX_FILE_BYTES){data.fill(0);throw new Error('Invalid document size.');}
 return {requestId:v.requestId,name:v.document.name,type:v.document.type,data,blockNumber:v.authorizedAtBlock};
}
export async function viewDocument(wallet:WalletProvider,s:GovernanceSnapshot,bidder:string,version:string,part:number,isCurrent:()=>boolean,signal:AbortSignal,requestFetch:typeof fetch=fetch):Promise<ViewedDocument>{
 if(!s.isCommission||s.paused||![2,3,4,5,6,9].includes(s.state))throw new Error('Only the assigned commission can view verified documents at this stage.');
 const b=s.bids.find(b=>getAddress(b.address)===getAddress(bidder));
 if(!b?.active||b.version!==version||b.outcomes[part]!==1||s.state<[2,3,4][part]||!s.openings[part]?.authorized||(part!==0&&!b.admitted)||(part===1&&!s.requiresTechnicalOffer)||(part===2&&s.requiresTechnicalOffer&&!b.technicalAccepted))throw new Error('This current bid part has not been verified and authorized for viewing.');
 await currentWallet(wallet,s);if(!isCurrent()||signal.aborted)throw new Error('Viewing request changed.');
 const nonce='0x'+Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');
 const request=validateDocumentRequest({context:{chainId:s.deployment.chainId,workflow:s.deployment.contracts.procurementWorkflow.toLowerCase(),tenderId:s.tenderId,bidder:bidder.toLowerCase(),version},part,viewer:s.account.toLowerCase(),timestamp:Date.now().toString(),nonce});
 const p=new BrowserProvider(wallet,'any',{cacheTimeout:-1});let signature;
 try{signature=await(await p.getSigner(s.account)).signMessage(documentMessage(request));}finally{p.destroy();}
 await currentWallet(wallet,s);if(!isCurrent()||signal.aborted)throw new Error('Viewing request changed.');
 const response=await requestFetch('/api/documents/view',{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Document-Signature':signature},body:JSON.stringify(request),signal});
 if(!response.ok){let message='Restricted document service unavailable. Start the separate document service and check its configuration.';try{const body=await response.json();if(typeof body?.error?.message==='string')message=body.error.message;}catch{}throw new Error(message);}
 const raw=await response.text();if(raw.length>2*MAX_FILE_BYTES)throw new Error('Document response is too large.');
 await currentWallet(wallet,s);if(!isCurrent()||signal.aborted)throw new Error('Viewing request changed.');
 return parseDocument(JSON.parse(raw),request);
}
export function safeDownloadName(name:string){return name.replace(/[\x00-\x1f\x7f/\\]/g,'_').replace(/^\.+/,'_').slice(0,255)||'bid-document';}
