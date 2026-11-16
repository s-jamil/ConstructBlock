import { type BidContext,type Evidence } from './bid-protocol.ts';
export type OpeningRequest={context:BidContext;part:number;service:string;timestamp:string};
export type OpeningEvidence={blockNumber:number;fingerprint:string;evidence:Evidence};
export function validateOpeningRequest(value:unknown):OpeningRequest {
 const r=value as OpeningRequest;
 const number=(v:unknown,bits:number)=>typeof v==='string'&&/^[1-9][0-9]{0,77}$/.test(v)&&BigInt(v)<2n**BigInt(bits);
 const address=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]{40}$/.test(v)&&!/^0x0{40}$/.test(v);
 if(!r||!r.context||!number(r.context.chainId,256)||!number(r.context.tenderId,256)||!number(r.context.version,64)||!address(r.context.workflow)||!address(r.context.bidder)||!address(r.service)||![0,1,2].includes(r.part)||typeof r.timestamp!=='string'||!/^[0-9]{13}$/.test(r.timestamp))throw new Error('Invalid opening request.');
 if(Object.keys(r).sort().join(',')!=='context,part,service,timestamp'||Object.keys(r.context).sort().join(',')!=='bidder,chainId,tenderId,version,workflow')throw new Error('Unknown opening request fields.');
 return r;
}
export function openingMessage(r:OpeningRequest){const c=r.context;return ['constructBlock opening service authorization v1','Action: retrieve authorized encrypted part',`Chain: ${c.chainId}`,`Workflow: ${c.workflow}`,`Tender: ${c.tenderId}`,`Bidder: ${c.bidder}`,`Version: ${c.version}`,`Part: ${r.part}`,`Service: ${r.service}`,`Issued at milliseconds: ${r.timestamp}`,'This request does not release a private key or authorize a different part.'].join('\n');}
