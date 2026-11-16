import {RestrictedDocumentViewer} from './RestrictedDocumentViewer';
import {useEffect,useRef,useState} from 'react';
import {ZeroAddress,ZeroHash} from 'ethers';
import type {ChainStatus} from './api';
import {publicationMessage,type WalletProvider} from './publication';
import {loadGovernance,validateGovernanceAction,actionUnavailable,submitGovernance,confirmGovernance,restoreGovernanceTransaction,type GovernanceSnapshot,type GovernanceAction,type GovernanceTransaction} from './governance-client';
const key='constructBlock.pendingGovernance.v1',parts=['Initial','Technical','Financial'],states=['Open','Closed','Initial opening','Technical review','Financial opening','Selected','Approved','Cancelled','Unsuccessful','Rejected'],outcomes=['Pending','Verified','Failed'];
const wallet=()=> (window as Window & {ethereum?:WalletProvider}).ethereum;
function saved(){try{const raw=localStorage.getItem(key);return raw?restoreGovernanceTransaction(JSON.parse(raw)):null;}catch{return null;}}
function label(a:GovernanceAction){if(a.kind==='select')return 'Select bidder';if(a.kind==='final')return a.accept?'Approve selection':'Reject selection';if(a.kind==='extract')return 'Record public extract digest';return a.kind==='close'?'Close tender':a.kind==='request'?`Authorize ${parts[a.part].toLowerCase()} opening`:a.kind==='admission'?(a.accept?'Admit bidder':'Exclude bidder'):(a.accept?'Accept technical offer':'Reject technical offer');}

export function GovernanceWorkspace({deployment,ready}:{deployment?:ChainStatus;ready:boolean}){
 const [id,setId]=useState(''),[snapshot,setSnapshot]=useState<GovernanceSnapshot|null>(null),[digest,setDigest]=useState(''),[review,setReview]=useState<GovernanceAction|null>(null);
 const [pending,setPending]=useState<GovernanceTransaction|null>(saved),[receipt,setReceipt]=useState<number|null>(null),[failed,setFailed]=useState(false),[message,setMessage]=useState(''),[busy,setBusy]=useState(''),[checking,setChecking]=useState(false),[abandon,setAbandon]=useState(false);
 const epoch=useRef(0),mounted=useRef(true),lock=useRef(false),confirmLock=useRef(false);
 const pendingActive=Boolean(pending)&&receipt===null&&!failed;
 const digestInvalid=digest.trim()!==''&&(!/^0x[0-9a-fA-F]{64}$/.test(digest.trim())||digest.trim().toLowerCase()===ZeroHash);
 const needsDigest=snapshot&&(snapshot.isCommission&&[2,3,4,5,6,9].includes(snapshot.state)||snapshot.isApprover&&snapshot.state===5);
 function invalidate(){epoch.current++;setSnapshot(null);setReview(null);setDigest('');}
 useEffect(()=>{mounted.current=true;const w=wallet(),change=()=>{invalidate();setMessage('Wallet changed. Load the tender again. Broadcast transactions remain tracked.');};w?.on?.('accountsChanged',change);w?.on?.('chainChanged',change);w?.on?.('disconnect',change);return()=>{mounted.current=false;epoch.current++;w?.removeListener?.('accountsChanged',change);w?.removeListener?.('chainChanged',change);w?.removeListener?.('disconnect',change);};},[]);
 useEffect(()=>{invalidate();},[deployment?.chainId,deployment?.contracts.roleRegistry,deployment?.contracts.procurementWorkflow]);
 async function run(text:string,action:(w:WalletProvider,current:()=>boolean)=>Promise<void>){
  if(lock.current)return;const w=wallet();if(!w){setMessage('Use a browser wallet extension and refresh this page.');return;}
  lock.current=true;setBusy(text);setMessage('');const version=epoch.current;
  try{await action(w,()=>mounted.current&&epoch.current===version);}catch(e){if(mounted.current){const code=(e as {code?:unknown})?.code;setMessage(code===4001||code==='ACTION_REJECTED'?publicationMessage(e):e instanceof Error?e.message:'Workflow request failed.');}}
  finally{lock.current=false;if(mounted.current)setBusy('');}
 }
 async function refresh(w:WalletProvider,current:()=>boolean,connect=false){if(!deployment)return;const s=await loadGovernance(w,deployment,id.trim(),connect);if(current()){setSnapshot(s);setReview(null);}}
 function unavailable(a:GovernanceAction){if(!snapshot)return 'Load an actor workspace first.';try{return actionUnavailable(snapshot,a);}catch(e){return e instanceof Error?e.message:'Invalid action.';}}
 function choose(a:GovernanceAction){try{const action=validateGovernanceAction(a),reason=unavailable(action);if(reason)throw new Error(reason);setReview(action);setMessage('');}catch(e){setMessage(e instanceof Error?e.message:'Invalid review.');}}
 async function check(tx:GovernanceTransaction,manual=true){
  if(confirmLock.current)return;const w=wallet();if(!w)return;confirmLock.current=true;setChecking(true);
  try{const result=await confirmGovernance(w,tx);if(mounted.current){if(result){setReceipt(result.blockNumber);setReview(null);setSnapshot(null);setMessage('Transaction confirmed. Reload the tender to see the current stage.');}else if(manual)setMessage('Still pending. Inspect wallet activity; do not submit the action again.');}}
  catch(e){if(mounted.current){if((e as {code?:string}).code==='TRANSACTION_REVERTED')setFailed(true);setMessage(e instanceof Error?e.message:'Confirmation failed.');}}
  finally{confirmLock.current=false;if(mounted.current)setChecking(false);}
 }
 useEffect(()=>{if(!pendingActive||!pending)return;let stop=false,timer:ReturnType<typeof setTimeout>|undefined,n=0;async function tick(){await check(pending!,false);if(!stop&&++n<40)timer=setTimeout(tick,1500);}void tick();return()=>{stop=true;if(timer)clearTimeout(timer);};},[pending,pendingActive]);
 function clearTracking(){setPending(null);setReceipt(null);setFailed(false);setAbandon(false);setReview(null);try{localStorage.removeItem(key);}catch{}}
 function actionButton(a:GovernanceAction){const reason=unavailable(a);return <button type="button" className="button secondary" disabled={Boolean(busy)||pendingActive||!ready||Boolean(reason)} title={reason??''} onClick={()=>choose(a)}>{label(a)}</button>;}
 return <section className="panel officer-panel" id="governance-workspace" aria-labelledby="governance-heading">
  <div className="panel-heading"><div><h2 id="governance-heading">Commission and approval workspace</h2><p>Wallet-signed workflow actions · local research prototype</p></div></div>
  <p>Load a tender with its assigned commission or a separate government final-approver wallet. Review each action before signing. Verification outcomes come from the separate opening service; a separate restricted service releases verified documents to the assigned commission.</p>
  <div className="bid-connect"><label htmlFor="governance-tender">Tender ID<input id="governance-tender" inputMode="numeric" value={id} disabled={Boolean(busy)||pendingActive} onChange={e=>{setId(e.target.value);invalidate();}}/></label>
  <button className="button primary" type="button" disabled={!ready||Boolean(busy)||pendingActive} onClick={()=>void run('Verifying wallet role and tender…',(w,c)=>refresh(w,c,true))}>Connect actor and load tender</button>
  <button className="button secondary" type="button" disabled={!ready||Boolean(busy)||pendingActive||!snapshot} onClick={()=>void run('Refreshing workflow…',(w,c)=>refresh(w,c))}>Refresh workflow</button></div>
  {!ready&&<p className="connection-notice">Blockchain readiness must be verified first.</p>}{busy&&<p role="status">{busy}</p>}{message&&<p className="publication-message" role="alert">{message}</p>}
  {snapshot&&<><div className="publication-review"><strong>{snapshot.isCommission?'Assigned commission':'Final approver'} verified</strong><p><code>{snapshot.account}</code></p><p>Tender #{snapshot.tenderId} · {states[snapshot.state]}{snapshot.paused?' · PAUSED':''}</p><p>Deadline UTC: {new Date(Number(snapshot.deadline)*1000).toISOString()}</p><p>Active bids: {snapshot.activeBids} · pending in current opening: {snapshot.pendingOpenings} · snapshot block {snapshot.blockNumber}</p><p>Commission: <code>{snapshot.commission}</code></p>
  {snapshot.isCommission&&<>{actionButton({kind:'close'})}{snapshot.state===0&&BigInt(snapshot.deadline)>BigInt(snapshot.chainTime)&&<p>The contract permits closure only after the deadline.</p>}</>}</div>
  <h3>Commission-authorized opening stages</h3>
  {!snapshot.isCommission&&<p className="governance-role-help">You are connected as a final approver. Opening bids, recording admission decisions and viewing documents require the assigned commission wallet: <code>{snapshot.commission}</code>. Final approval becomes available after the commission selects a bidder.</p>}
  <div className="governance-stages">{snapshot.openings.map((o,part)=>{
   const omitted=part===1&&!snapshot.requiresTechnicalOffer;
   return <article className="governance-stage" key={part}><h4>{parts[part]}</h4><p>{omitted?'Not required':o.authorized?'Opening authorized':'Not requested'}</p>
    {!omitted&&snapshot.isCommission&&<div className="bid-actions">{actionButton({kind:'request',part})}</div>}
   </article>;
  })}</div>
  <h3>Bid verification and human decisions</h3><p>Verified means the opening service recorded successful integrity checks. It is not an admission decision or an award. Pending or failed checks cannot be accepted.</p>
  {needsDigest&&<div className="governance-digest">
   <label htmlFor="governance-reason">Decision or public extract evidence digest</label>
   <input id="governance-reason" value={digest} maxLength={66} spellCheck={false} autoComplete="off" aria-invalid={digestInvalid} aria-describedby={digestInvalid?'governance-digest-help governance-digest-error':'governance-digest-help'} disabled={Boolean(busy)||pendingActive} placeholder="0x followed by 64 hexadecimal characters" onChange={e=>{setDigest(e.target.value);setReview(null);}}/>
   <small id="governance-digest-help">Enter the SHA-256 hash of the decision record or public extract. A wallet address is not an evidence digest. Enter no bid contents or personal information.</small>
   {digestInvalid&&<p className="validation" id="governance-digest-error" role="alert">Enter a nonzero 32-byte hash: 0x followed by 64 hexadecimal characters.</p>}
  </div>}
  {!snapshot.bids.length&&<p>No recorded bidders for this tender.</p>}
  <div className="governance-bids">{snapshot.bids.map(b=><article className="governance-bid" key={b.address}><strong><code>{b.address}</code></strong><p>Version {b.version} · {b.active?'Active':'Withdrawn'}</p><p>{parts.map((name,i)=>`${name}: ${i===1&&!snapshot.requiresTechnicalOffer?'Not required':outcomes[b.outcomes[i]]}`).join(' · ')}</p><p>Admission: {b.admissionRecorded?(b.admitted?'Admitted':'Excluded'):'Not recorded'} · Technical decision: {!snapshot.requiresTechnicalOffer?'Not required':b.technicalDecisionRecorded?(b.technicalAccepted?'Accepted':'Rejected'):'Not recorded'}</p>
   {snapshot.isCommission&&b.active&&<div className="bid-actions">{snapshot.state===2&&[true,false].map(accept=><span key={String(accept)}>{actionButton({kind:'admission',bidder:b.address,version:b.version,accept,reasonDigest:digest.trim()})}</span>)}{snapshot.state===3&&snapshot.requiresTechnicalOffer&&[true,false].map(accept=><span key={String(accept)}>{actionButton({kind:'technical',bidder:b.address,version:b.version,accept,reasonDigest:digest.trim()})}</span>)}{snapshot.state===4&&actionButton({kind:'select',bidder:b.address,version:b.version,reasonDigest:digest.trim()})}</div>}
  </article>)}</div><p className="field-help">Reload after the opening operator records results or another actor acts. The public API continues to expose only public metadata; these actor reads use your wallet RPC.</p></>}
  {snapshot&&<RestrictedDocumentViewer snapshot={snapshot} disabled={Boolean(busy)||pendingActive||!ready}/>}
  {snapshot&&snapshot.selectedBidder!==ZeroAddress&&<div className="publication-review"><h3>Selection and final outcome</h3><p>Current tender state: <strong>{states[snapshot.state]}</strong></p><p>{snapshot.state===5?'Provisional selection · awaiting separate approval':snapshot.state===6?'Selection approved':snapshot.state===9?'Selection rejected':'Recorded selection'}: <code>{snapshot.selectedBidder}</code></p><p>Selection evidence <code>{snapshot.selectionDigest}</code></p><p>Selection recorded UTC: {new Date(Number(snapshot.commissionCompletedAt)*1000).toISOString()}</p>
   {snapshot.finalDecision&&<><p>Final decision by <code>{snapshot.finalDecision.actor}</code> · block {snapshot.finalDecision.blockNumber}</p><p>Final decision evidence <code>{snapshot.finalDecision.reasonDigest}</code></p></>}
   <p>Public extract digest <code>{snapshot.publicExtractDigest===ZeroHash?'Not recorded':snapshot.publicExtractDigest}</code></p>
   {snapshot.isApprover&&snapshot.state===5&&<><p>The final approver must be a different address from the selecting commission. This decision cannot be overwritten.</p><div className="bid-actions">{[true,false].map(accept=><span key={String(accept)}>{actionButton({kind:'final',accept,reasonDigest:digest.trim(),selectedBidder:snapshot.selectedBidder,selectionDigest:snapshot.selectionDigest})}</span>)}</div></>}
   {snapshot.isCommission&&[5,6,9].includes(snapshot.state)&&<><p>Recording a digest does not upload or publish the extract, and does not approve the selection. {snapshot.publicExtractDigest!==ZeroHash?'This replaces the currently recorded digest; review the old and new values.':''}</p>{actionButton({kind:'extract',reasonDigest:digest.trim(),selectedBidder:snapshot.selectedBidder,selectionDigest:snapshot.selectionDigest,previousExtractDigest:snapshot.publicExtractDigest})}</>}
  </div>}
  {review&&snapshot&&!pendingActive&&<div className="publication-review"><h3>Review workflow action</h3><p><strong>{label(review)}</strong> · tender #{snapshot.tenderId}</p><p>Signer <code>{snapshot.account}</code> · chain {snapshot.deployment.chainId}</p><p>Contract <code>{snapshot.deployment.contracts.procurementWorkflow}</code></p>{(review.kind==='admission'||review.kind==='technical'||review.kind==='select')&&<><p>Bidder <code>{review.bidder}</code> · version {review.version}</p><p>Evidence <code>{review.reasonDigest}</code></p><p>This selection or human decision cannot be overwritten in this contract version.</p></>}
   {(review.kind==='final'||review.kind==='extract')&&<><p>Selected bidder <code>{review.selectedBidder}</code></p><p>Selection evidence <code>{review.selectionDigest}</code></p><p>{review.kind==='final'?'Final decision evidence':'New public extract digest'} <code>{review.reasonDigest}</code></p>{review.kind==='extract'?<p>Previous extract <code>{review.previousExtractDigest}</code> · this transaction records a hash only.</p>:<p>Final outcome: {review.accept?'Approved':'Rejected'}. This decision cannot be overwritten.</p>}</>}
   <button className="button primary" type="button" disabled={Boolean(busy)||!ready||Boolean(pending)} onClick={()=>void run('Review and approve the workflow transaction in your wallet…',async(w,current)=>{
    const tx=await submitGovernance(w,snapshot,review,current);if(mounted.current){setPending(tx);setReceipt(null);setFailed(false);setAbandon(false);try{localStorage.setItem(key,JSON.stringify(tx));}catch{setMessage('Transaction broadcast. Save its hash because browser tracking could not be stored.');}}
   })}>Sign reviewed action</button></div>}
  {pending&&<div className="publication-transaction" aria-live="polite"><strong>{receipt!==null?'Workflow action confirmed':failed?'Workflow transaction reverted':'Workflow transaction submitted · pending'}</strong><p>{label(pending.action)} · tender #{pending.tenderId}</p><code>{pending.hash}</code>{receipt!==null&&<p>Matching event confirmed in block {receipt}. Load the tender again to refresh the dashboard.</p>}
   {pendingActive&&<><button className="button secondary" type="button" disabled={checking} onClick={()=>void check(pending)}>{checking?'Checking…':'Check workflow confirmation'}</button><p>Changing wallets does not cancel this transaction. Inspect replaced or dropped transactions before starting another action.</p><label className="publication-checkbox"><input type="checkbox" checked={abandon} onChange={e=>setAbandon(e.target.checked)}/>I checked wallet activity and want to stop tracking this hash. This does not cancel it.</label><button type="button" className="button secondary" disabled={!abandon||checking||Boolean(busy)} onClick={()=>{clearTracking();invalidate();setMessage('Tracking cleared. Reload the on-chain state before preparing another action.');}}>Stop tracking checked transaction</button></>}
   {(receipt!==null||failed)&&<button className="button secondary" type="button" onClick={()=>{clearTracking();invalidate();}}>Clear receipt for next action</button>}
  </div>}
 </section>;
}
