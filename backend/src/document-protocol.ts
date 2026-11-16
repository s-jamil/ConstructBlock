// Shared signed request schema; contains no server or custody imports.
import {validateOpeningRequest} from './opening-protocol.ts';
import type {BidContext} from './bid-protocol.ts';
export type DocumentRequest={context:BidContext;part:number;viewer:string;timestamp:string;nonce:string};
export function validateDocumentRequest(value:unknown):DocumentRequest{
 const r=value as DocumentRequest;
 if(!r||Object.keys(r).sort().join(',')!=='context,nonce,part,timestamp,viewer'||!/^0x[0-9a-f]{32}$/.test(r.nonce))throw new Error('Invalid document viewing request.');
 validateOpeningRequest({context:r.context,part:r.part,service:r.viewer,timestamp:r.timestamp});
 // Canonical order also makes evidence comparisons deterministic.
 const c=r.context;
 return {context:{chainId:c.chainId,workflow:c.workflow,tenderId:c.tenderId,bidder:c.bidder,version:c.version},part:r.part,viewer:r.viewer,timestamp:r.timestamp,nonce:r.nonce};
}
export function documentMessage(r:DocumentRequest){const c=r.context;return ['constructBlock restricted document authorization v1','Action: view one verified bid document',`Chain: ${c.chainId}`,`Workflow: ${c.workflow}`,`Tender: ${c.tenderId}`,`Bidder: ${c.bidder}`,`Version: ${c.version}`,`Part: ${r.part}`,`Viewer: ${r.viewer}`,`Issued at milliseconds: ${r.timestamp}`,`Single-use nonce: ${r.nonce}`,'This releases this document to the assigned commission only. It does not approve a bid or authorize other parts.'].join('\n');}
