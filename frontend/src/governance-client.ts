import {BrowserProvider,Contract,Interface,getAddress,id,ZeroAddress,ZeroHash} from 'ethers';
import artifact from '../../backend/src/abi/ProcurementWorkflow.json' with {type:'json'};
import type {ChainStatus} from './api.ts';
import type {WalletProvider} from './publication.ts';
export type GovernanceAction={kind:'close'}|{kind:'request';part:number}|{kind:'admission';bidder:string;version:string;accept:boolean;reasonDigest:string}|{kind:'technical';bidder:string;version:string;accept:boolean;reasonDigest:string}|{kind:'select';bidder:string;version:string;reasonDigest:string}|{kind:'final';accept:boolean;reasonDigest:string;selectedBidder:string;selectionDigest:string}|{kind:'extract';reasonDigest:string;selectedBidder:string;selectionDigest:string;previousExtractDigest:string};
export type BidReview={address:string;version:string;active:boolean;admissionRecorded:boolean;admitted:boolean;technicalDecisionRecorded:boolean;technicalAccepted:boolean;outcomes:number[]};
export type GovernanceSnapshot={account:string;deployment:ChainStatus;tenderId:string;blockNumber:number;chainTime:number;state:number;deadline:string;commission:string;isCommission:boolean;isApprover:boolean;selectedBidder:string;selectionDigest:string;publicExtractDigest:string;commissionCompletedAt:string;finalDecision:{approved:boolean;actor:string;reasonDigest:string;blockNumber:number}|null;paused:boolean;requiresTechnicalOffer:boolean;activeBids:string;pendingOpenings:string;admissionDecisions:string;technicalDecisions:string;openings:{requested:boolean;authorized:boolean}[];bids:BidReview[]};
export type GovernanceTransaction={hash:string;account:string;tenderId:string;chainId:string;workflow:string;action:GovernanceAction};
const abi=new Interface(artifact.abi),roles=['function hasRole(bytes32,address) view returns(bool)'];
const provider=(wallet:WalletProvider)=>new BrowserProvider(wallet,'any',{cacheTimeout:-1});
function tenderId(value:string){if(!/^[1-9][0-9]{0,77}$/.test(value)||BigInt(value)>=2n**256n)throw new Error('Enter a positive uint256 tender ID.');return value;}
export function validateGovernanceAction(value:unknown):GovernanceAction {
 const a=value as GovernanceAction;if(!a||typeof a!=='object')throw new Error('Choose a workflow action.');
 if(a.kind==='close')return {kind:'close'};
 if(a.kind==='request'){if(!Number.isInteger(a.part)||a.part<0||a.part>2)throw new Error('Choose an opening part.');return {kind:a.kind,part:a.part};}
 if(a.kind==='final'||a.kind==='extract'){
  const digest=(x:string)=>/^0x[0-9a-f]{64}$/i.test(x)&&x.toLowerCase()!==ZeroHash;
  const selectedBidder=getAddress(a.selectedBidder);
  if(selectedBidder===ZeroAddress||!digest(a.reasonDigest)||!digest(a.selectionDigest))throw new Error('Provide the selected bidder and nonzero selection and evidence digests.');
  const base={reasonDigest:a.reasonDigest.toLowerCase(),selectedBidder,selectionDigest:a.selectionDigest.toLowerCase()};
  if(a.kind==='final'){if(typeof a.accept!=='boolean')throw new Error('Choose approval or rejection.');return {kind:'final',accept:a.accept,...base};}
  if(!/^0x[0-9a-f]{64}$/i.test(a.previousExtractDigest))throw new Error('Invalid previous extract digest.');
  return {kind:'extract',...base,previousExtractDigest:a.previousExtractDigest.toLowerCase()};
 }
 if(a.kind==='admission'||a.kind==='technical'||a.kind==='select'){
  const bidder=getAddress(a.bidder);if(bidder===ZeroAddress)throw new Error('Choose a nonzero bidder.');
  if(!/^[1-9][0-9]{0,19}$/.test(a.version)||BigInt(a.version)>=2n**64n)throw new Error('Invalid reviewed bid version.');
  if((a.kind!=='select'&&typeof a.accept!=='boolean')||!/^0x[0-9a-f]{64}$/i.test(a.reasonDigest)||a.reasonDigest.toLowerCase()===ZeroHash)throw new Error('Provide a nonzero 32-byte decision evidence digest.');
  if(a.kind==='select')return {kind:'select',bidder,version:a.version,reasonDigest:a.reasonDigest.toLowerCase()};
  return {kind:a.kind,bidder,version:a.version,accept:a.accept,reasonDigest:a.reasonDigest.toLowerCase()};
 }
 throw new Error('Unsupported workflow action.');
}
async function checkWallet(wallet:WalletProvider,chain:string,account?:string){
 const actual=await wallet.request({method:'eth_chainId'});
 if(typeof actual!=='string'||!/^0x[0-9a-f]+$/i.test(actual)||BigInt(actual).toString()!==chain)throw new Error(`Switch wallet to chain ${chain}.`);
 if(account){const accounts=await wallet.request({method:'eth_accounts'});if(!Array.isArray(accounts)||!accounts[0]||getAddress(accounts[0])!==account)throw new Error('Wallet account changed. Reconnect and review again.');}
}
export async function loadGovernance(wallet:WalletProvider,deployment:ChainStatus,value:string,connect=true):Promise<GovernanceSnapshot>{
 const tid=tenderId(value),accounts=await wallet.request({method:connect?'eth_requestAccounts':'eth_accounts'});
 if(!Array.isArray(accounts)||!accounts[0])throw new Error('Select a commission or final-approver wallet.');
 const account=getAddress(accounts[0]);await checkWallet(wallet,deployment.chainId,account);
 const p=provider(wallet);
 try{
  const block=await p.getBlock('latest');if(!block)throw new Error('Blockchain is unavailable.');const options={blockTag:block.number};
  const [rc,wc]=await Promise.all([p.getCode(deployment.contracts.roleRegistry,block.number),p.getCode(deployment.contracts.procurementWorkflow,block.number)]);
  if(rc==='0x'||wc==='0x')throw new Error('Configured contracts are missing on this network.');
  const workflow=new Contract(deployment.contracts.procurementWorkflow,artifact.abi,p),registry=new Contract(deployment.contracts.roleRegistry,roles,p);
  if(getAddress(await workflow.registry(options))!==getAddress(deployment.contracts.roleRegistry))throw new Error('Workflow and registry do not match.');
  try {if(await workflow.OPENING_POLICY_VERSION(options)!==2n)throw new Error();}catch{throw new Error('This app requires commission-authorized opening policy 2. Deploy the revised contracts and update configuration.');}
  const [t,commissionRole,approverRole,paused]=await Promise.all([workflow.getTender(tid,options),registry.hasRole(id('COMMISSION_ROLE'),account,options),registry.hasRole(id('APPROVAL_ROLE'),account,options),workflow.paused(options)]);
  const commission=getAddress(t.commission),isCommission=Boolean(commissionRole)&&commission===account,isApprover=Boolean(approverRole)&&commission!==account;
  if(!isCommission&&!isApprover)throw new Error('This wallet is neither the assigned commission nor an eligible final approver for this tender.');
  const openings=await Promise.all([0,1,2].map(async part=>{
   const o=await workflow.getOpening(tid,part,options);
   return {requested:Boolean(o.requested),authorized:Boolean(o.authorized)};
  }));
  // Restricted actor view reads directly from the wallet RPC, not the public metadata API.
  const events=await workflow.queryFilter(workflow.filters.BidSubmitted(tid),0,block.number);
  const addresses=[...new Set(events.filter(e=>'args'in e).map(e=>getAddress((e as {args:any}).args.bidder)))];
  if(addresses.length>100)throw new Error('This prototype supports up to 100 bidder addresses in the actor workspace. Use an indexed service for larger tenders.');
  const bids:BidReview[]=[];
  for(const address of addresses){const [b,...outcomes]=await Promise.all([workflow.getBid(tid,address,options),...[0,1,2].map(part=>workflow.getOutcome(tid,address,part,options))]);
   bids.push({address,version:b.version.toString(),active:Boolean(b.active),admissionRecorded:Boolean(b.admissionRecorded),admitted:Boolean(b.admitted),technicalDecisionRecorded:Boolean(b.technicalDecisionRecorded),technicalAccepted:Boolean(b.technicalAccepted),outcomes:outcomes.map(Number)});
  }
  let finalDecision:GovernanceSnapshot['finalDecision']=null;
  if(Number(t.state)===6||Number(t.state)===9){
   const decisions=await workflow.queryFilter(workflow.filters.StateChanged(tid),0,block.number);
   const final=decisions.filter(e=>'args'in e&&(Number((e as {args:any}).args.state)===6||Number((e as {args:any}).args.state)===9));
   if(final.length!==1||!('args'in final[0]))throw new Error('Cannot verify the final decision event.');
   finalDecision={approved:Number(final[0].args.state)===6,actor:getAddress(final[0].args.actor),reasonDigest:String(final[0].args.reasonDigest),blockNumber:final[0].blockNumber};
  }
  await checkWallet(wallet,deployment.chainId,account);
  return {account,deployment,tenderId:tid,blockNumber:block.number,chainTime:block.timestamp,state:Number(t.state),deadline:t.deadline.toString(),commission,isCommission,isApprover,selectedBidder:getAddress(t.selectedBidder),selectionDigest:String(t.selectionDigest),publicExtractDigest:String(t.publicExtractDigest),commissionCompletedAt:t.commissionCompletedAt.toString(),finalDecision,paused:Boolean(paused),requiresTechnicalOffer:Boolean(t.requiresTechnicalOffer),activeBids:t.activeBids.toString(),pendingOpenings:t.pendingOpenings.toString(),admissionDecisions:t.admissionDecisions.toString(),technicalDecisions:t.technicalDecisions.toString(),openings,bids};
 }finally{p.destroy();}
}
export function actionUnavailable(s:GovernanceSnapshot,action:GovernanceAction):string|null {
 const a=validateGovernanceAction(action);if(s.paused)return 'The government has paused procurement actions.';
 if(a.kind==='final'||a.kind==='extract'){
  if(getAddress(s.selectedBidder)!==a.selectedBidder||s.selectionDigest.toLowerCase()!==a.selectionDigest)return 'The selected bidder or selection evidence changed. Reload and review again.';
  if(a.kind==='final'){
   if(!s.isApprover||s.account===s.commission)return 'Use a government final-approver wallet distinct from the commission.';
   return s.state===5?null:'Final approval or rejection requires a pending Selected tender.';
  }
  if(!s.isCommission)return 'Only the assigned commission can record the public extract digest.';
  if(![5,6,9].includes(s.state))return 'Record an extract only after selection, approval or rejection.';
  if(s.publicExtractDigest.toLowerCase()!==a.previousExtractDigest)return 'The extract changed since review. Reload before replacing it.';
  return null;
 }
 if(!s.isCommission)return 'Only the assigned commission can perform this action.';
 if(a.kind==='close')return s.state!==0?'Only an Open tender can be closed.':BigInt(s.deadline)<=BigInt(s.chainTime)?null:'Tender closure requires its submission deadline to have passed.';
 if(a.kind==='request'){
  if(BigInt(s.deadline)>BigInt(s.chainTime))return 'Opening requires the submission deadline to have passed.';
  if(s.openings[a.part].requested)return 'An opening request already exists for this part.';
  if(a.part===0)return s.state===1&&BigInt(s.activeBids)>0n?null:'Close the tender with at least one active bid first.';
  if(a.part===1&&!s.requiresTechnicalOffer)return 'This tender does not require a technical offer.';
  if(s.state!==(a.part===1?2:s.requiresTechnicalOffer?3:2)||s.pendingOpenings!=='0'||s.bids.some(b=>b.active&&!b.admissionRecorded))return 'Complete the preceding opening and admission decisions first.';
  if(a.part===1)return s.bids.some(b=>b.active&&b.admitted)?null:'At least one admitted bid is required.';
  if(s.requiresTechnicalOffer&&s.bids.some(b=>b.active&&b.admitted&&!b.technicalDecisionRecorded))return 'Complete all required technical decisions first.';
  return s.bids.some(b=>b.active&&b.admitted&&(!s.requiresTechnicalOffer||b.technicalAccepted))?null:'At least one financially eligible bid is required.';
 }
 const b=s.bids.find(b=>b.address.toLowerCase()===a.bidder.toLowerCase());
 if(!b||!b.active||b.version!==a.version)return 'The reviewed bid version is not active.';
 if(a.kind==='select'){
  if(s.state!==4||s.pendingOpenings!=='0')return 'Complete all eligible financial verification outcomes before selection.';
  return b.admitted&&(!s.requiresTechnicalOffer||b.technicalAccepted)&&b.outcomes[2]===1?null:'Select an eligible bidder with verified financial evidence.';
 }
 const technical=a.kind==='technical';
 if(s.state!==(technical?3:2)||(technical?(!b.admitted||b.technicalDecisionRecorded):b.admissionRecorded))return 'This decision is not available at the current stage.';
 const outcome=b.outcomes[technical?1:0];if(outcome===0)return 'Wait for the opening service to record verification.';
 if(a.accept&&outcome!==1)return 'A failed verification cannot be accepted.';
 return null;
}
function call(a:GovernanceAction,tid:string){if(a.kind==='select')return {method:'selectBidder',args:[tid,a.bidder,a.reasonDigest]};if(a.kind==='final')return {method:'decideFinalApproval',args:[tid,a.accept,a.reasonDigest]};if(a.kind==='extract')return {method:'recordPublicExtract',args:[tid,a.reasonDigest]};if(a.kind==='close')return {method:'closeTender',args:[tid]};if(a.kind==='request')return {method:'requestOpening',args:[tid,a.part]};return {method:a.kind==='admission'?'recordAdmission':'recordTechnicalDecision',args:[tid,a.bidder,a.accept,a.reasonDigest]};}
export async function submitGovernance(wallet:WalletProvider,review:GovernanceSnapshot,action:GovernanceAction,isCurrent=()=>true):Promise<GovernanceTransaction>{
 const a=validateGovernanceAction(action);if(!isCurrent())throw new Error('Wallet or review changed. Reconnect.');
 const current=await loadGovernance(wallet,review.deployment,review.tenderId,false);
 if(current.account!==review.account)throw new Error('Wallet account changed. Reconnect.');
 const unavailable=actionUnavailable(current,a);if(unavailable)throw new Error(unavailable);
 const p=provider(wallet);
 try{
  const workflow=new Contract(review.deployment.contracts.procurementWorkflow,artifact.abi,await p.getSigner(review.account)),c=call(a,review.tenderId),fn=workflow.getFunction(c.method);
  await fn.staticCall(...c.args);const gas=await fn.estimateGas(...c.args);
  await checkWallet(wallet,review.deployment.chainId,review.account);if(!isCurrent())throw new Error('Wallet or review changed. Review again.');
  const tx=await fn(...c.args,{gasLimit:gas*120n/100n});
  return {hash:tx.hash,account:review.account,tenderId:review.tenderId,chainId:review.deployment.chainId,workflow:review.deployment.contracts.procurementWorkflow,action:a};
 }finally{p.destroy();}
}
export function parseGovernanceReceipt(receipt:{hash:string;from:string;to:string|null;status:number|null;blockNumber:number;logs:readonly {address:string;topics:readonly string[];data:string}[]},tx:GovernanceTransaction){
 if(receipt.hash.toLowerCase()!==tx.hash.toLowerCase())throw new Error('Unexpected transaction receipt.');
 if(getAddress(receipt.from)!==getAddress(tx.account)||!receipt.to||getAddress(receipt.to)!==getAddress(tx.workflow))throw new Error('Receipt transaction sender or destination differs from the reviewed action.');
 if(receipt.status!==1)throw Object.assign(new Error('The workflow transaction reverted. Refresh before deciding whether to retry.'),{code:'TRANSACTION_REVERTED'});
 const a=tx.action;
 const events=receipt.logs.filter(l=>l.address.toLowerCase()===tx.workflow.toLowerCase()).flatMap(l=>{try{const e=abi.parseLog(l);return e?[e]:[];}catch{return [];}}).filter(e=>{
  if(e.args.tenderId?.toString()!==tx.tenderId)return false;
  if(a.kind==='select')return e.name==='SelectionRecorded'&&getAddress(e.args.bidder)===a.bidder&&e.args.decisionDigest.toLowerCase()===a.reasonDigest;
  if(a.kind==='final')return e.name==='StateChanged'&&Number(e.args.state)===(a.accept?6:9)&&getAddress(e.args.actor)===getAddress(tx.account)&&e.args.reasonDigest.toLowerCase()===a.reasonDigest;
  if(a.kind==='extract')return e.name==='PublicExtractRecorded'&&e.args.extractDigest.toLowerCase()===a.reasonDigest;
  if(a.kind==='close')return e.name==='StateChanged'&&Number(e.args.state)===1&&getAddress(e.args.actor)===getAddress(tx.account)&&e.args.reasonDigest===ZeroHash;
  if(a.kind==='request')return e.name==='OpeningRequested'&&Number(e.args.part)===a.part&&getAddress(e.args.commission)===getAddress(tx.account);
  return e.name===(a.kind==='admission'?'AdmissionRecorded':'TechnicalDecisionRecorded')&&getAddress(e.args.bidder)===getAddress(a.bidder)&&e.args[a.kind==='admission'?'admitted':'accepted']===a.accept&&e.args.reasonDigest.toLowerCase()===a.reasonDigest;
 });
 if(events.length!==1)throw new Error('Receipt does not contain the expected workflow event. Inspect the transaction before retrying.');
 if(a.kind==='request'){
  const logs=receipt.logs.filter(l=>l.address.toLowerCase()===tx.workflow.toLowerCase()).flatMap(l=>{try{const e=abi.parseLog(l);return e?[e]:[];}catch{return [];}});
  const authorized=logs.filter(e=>e.name==='OpeningAuthorized'&&e.args.tenderId.toString()===tx.tenderId&&Number(e.args.part)===a.part);
  const transitioned=logs.filter(e=>e.name==='StateChanged'&&e.args.tenderId.toString()===tx.tenderId&&Number(e.args.state)===[2,3,4][a.part]&&getAddress(e.args.actor)===getAddress(tx.account)&&e.args.reasonDigest===ZeroHash);
  if(authorized.length!==1||transitioned.length!==1)throw new Error('Receipt does not confirm commission opening authorization and its stage transition. Inspect the transaction before retrying.');
 }

 return {blockNumber:receipt.blockNumber,hash:receipt.hash};
}
export async function confirmGovernance(wallet:WalletProvider,tx:GovernanceTransaction){await checkWallet(wallet,tx.chainId);const p=provider(wallet);try{const receipt=await p.getTransactionReceipt(tx.hash);return receipt?parseGovernanceReceipt(receipt,tx):null;}finally{p.destroy();}}
export function restoreGovernanceTransaction(value:unknown):GovernanceTransaction {
 const tx=value as GovernanceTransaction;
 if(!tx||!/^0x[0-9a-f]{64}$/i.test(tx.hash)||!/^[1-9][0-9]{0,77}$/.test(tx.chainId)||BigInt(tx.chainId)>=2n**256n)throw new Error('Invalid saved workflow transaction.');
 const account=getAddress(tx.account),workflow=getAddress(tx.workflow);if(account===ZeroAddress||workflow===ZeroAddress)throw new Error('Invalid saved workflow address.');
 return {hash:tx.hash,account,workflow,chainId:tx.chainId,tenderId:tenderId(tx.tenderId),action:validateGovernanceAction(tx.action)};
}
