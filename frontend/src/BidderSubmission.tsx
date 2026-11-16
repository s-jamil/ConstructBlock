import {useEffect,useRef,useState} from 'react';
import type {ChainStatus} from './api';
import {publicationMessage,type WalletProvider} from './publication';
import {loadBidSession,openingKey,encryptPart,uploadBid,submitEncryptedBid,confirmBid,retrieveBid,canonicalBundle,PROTOCOL,MAX_FILE_BYTES,type BidSession,type BidBundle,type BidTransaction} from './bid-client';
import {validateBundle,MAX_BUNDLE_BYTES} from '../../backend/src/bid-protocol';
const pendingKey='constructBlock.pendingBid.v1';
function wallet(){return (window as Window & {ethereum?:WalletProvider}).ethereum;}
function initialPending():BidTransaction|null {
 try{const value=JSON.parse(localStorage.getItem(pendingKey)??'null');return value&&/^0x[0-9a-f]{64}$/i.test(value.hash)&&value.context&&Array.isArray(value.evidence)&&value.evidence.length===3?value:null;}catch{return null;}
}
function saveEncrypted(bundle:BidBundle){
 const url=URL.createObjectURL(new Blob([canonicalBundle(bundle)],{type:'application/json'}));const a=document.createElement('a');
 a.href=url;a.download=`constructBlock-tender-${bundle.context.tenderId}-version-${bundle.context.version}.encrypted.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function BidderSubmission({deployment,ready}:{deployment?:ChainStatus;ready:boolean}) {
 const [tenderId,setTenderId]=useState(''),[session,setSession]=useState<BidSession|null>(null);
 const [files,setFiles]=useState<Record<number,File>>({}),[bundle,setBundle]=useState<BidBundle|null>(null),[stored,setStored]=useState('');
 const [message,setMessage]=useState(''),[stage,setStage]=useState(''),[pending,setPending]=useState<BidTransaction|null>(initialPending);
 const [confirmed,setConfirmed]=useState<number|null>(null),[reverted,setReverted]=useState(false),[checking,setChecking]=useState(false);
 const epoch=useRef(0),mounted=useRef(true),lock=useRef(false),confirmLock=useRef(false);
 const busy=Boolean(stage),pendingActive=Boolean(pending)&&confirmed===null&&!reverted;
 function clearPrepared(){setSession(null);setBundle(null);setStored('');setFiles({});epoch.current++;}
 useEffect(()=>{
  mounted.current=true;const w=wallet();
  const invalidate=()=>{clearPrepared();setMessage('Wallet changed. Reconnect and prepare again. A broadcast bid remains tracked below.');};
  w?.on?.('accountsChanged',invalidate);w?.on?.('chainChanged',invalidate);w?.on?.('disconnect',invalidate);
  return ()=>{mounted.current=false;epoch.current++;w?.removeListener?.('accountsChanged',invalidate);w?.removeListener?.('chainChanged',invalidate);w?.removeListener?.('disconnect',invalidate);};
 },[]);
 useEffect(()=>{clearPrepared();},[deployment?.chainId,deployment?.contracts.roleRegistry,deployment?.contracts.procurementWorkflow]);
 async function run(label:string,action:(w:WalletProvider,current:()=>boolean)=>Promise<void>){
  if(lock.current)return;const w=wallet();if(!w){setMessage('Open this page in a browser with an Ethereum wallet extension, then refresh.');return;}
  lock.current=true;setStage(label);setMessage('');const version=epoch.current;
  try{await action(w,()=>mounted.current&&version===epoch.current);}catch(error){if(mounted.current)setMessage(error instanceof Error?error.message:publicationMessage(error));}
  finally{lock.current=false;if(mounted.current)setStage('');}
 }
 async function check(tx:BidTransaction,manual=true){
  if(confirmLock.current)return;const w=wallet();if(!w)return;confirmLock.current=true;setChecking(true);
  try{const receipt=await confirmBid(w,tx);if(mounted.current){if(receipt){setConfirmed(receipt.blockNumber);setMessage('');}else if(manual)setMessage('Bid not confirmed yet. Check wallet activity before retrying.');}}
  catch(error){if(mounted.current){const text=error instanceof Error?error.message:'Confirmation check failed.';setMessage(text);if(text.includes('transaction reverted'))setReverted(true);}}
  finally{confirmLock.current=false;if(mounted.current)setChecking(false);}
 }
 useEffect(()=>{
  if(!pendingActive||!pending)return;let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined,attempts=0;
  async function tick(){await check(pending!,false);if(!cancelled&&++attempts<40)timer=setTimeout(tick,1500);}
  void tick();return()=>{cancelled=true;if(timer)clearTimeout(timer);};
 },[pending,pendingActive]);
 const parts=session?.requiresTechnicalOffer?[0,1,2]:[0,2];
 return <section className="panel officer-panel" id="bidder-submission" aria-labelledby="bidder-heading">
  <div className="panel-heading"><div><h2 id="bidder-heading">Submit an encrypted bid</h2><p>Approved bidder workspace · local storage prototype</p></div><span className="tag">Bidder wallet</span></div>
  <p>Documents are encrypted in this browser before upload. Uploading stores a package; only a confirmed blockchain transaction records a bid. One file per required part, up to 1 MiB each.</p>
  {!ready&&<p className="connection-notice">Verify blockchain readiness before preparing a bid.</p>}
  <div className="bid-connect"><label htmlFor="bid-tender-id">Tender ID<input id="bid-tender-id" inputMode="numeric" value={tenderId} disabled={busy||pendingActive} onChange={e=>{setTenderId(e.target.value);clearPrepared();setMessage('');}}/></label>
  <button type="button" className="button secondary" disabled={!ready||busy||pendingActive} onClick={()=>void run('Verifying bidder and opening keys…',async(w,current)=>{
   if(!deployment)return;const result=await loadBidSession(w,deployment,tenderId.trim());if(current())setSession(result);
  })}>Connect bidder and load tender</button></div>
  {message&&<p role="alert" className="publication-message">{message}</p>}
  {stage&&<p role="status" className="publication-message">{stage}</p>}
  {session&&<><div className="publication-review"><p>Bidder <code>{session.account}</code></p><p>Tender #{session.context.tenderId} · version {session.context.version}{session.active?' · replaces your existing active bid':''}</p><p>Deadline UTC: {new Date(Number(session.deadline)*1000).toISOString()}</p></div>
   <fieldset className="publication-fields" disabled={busy||pendingActive||!ready}><legend>Required bid documents</legend>
    {parts.map(part=><label key={part}>{['Initial documents','Technical offer','Financial offer'][part]}<input type="file" onChange={e=>{const file=e.target.files?.[0];setBundle(null);setStored('');setFiles(previous=>{const next={...previous};if(file)next[part]=file;else delete next[part];return next;});setMessage(file&&file.size>MAX_FILE_BYTES?'Choose a file no larger than 1 MiB.':'');}}/><small>Public key fingerprint <code>{session.fingerprints[part]}</code></small></label>)}
    <button type="button" className="button primary" disabled={!parts.every(p=>files[p]?.size>0&&files[p]?.size<=MAX_FILE_BYTES)} onClick={()=>void run('Verifying public keys and encrypting locally…',async(_w,current)=>{
     const encrypted=[];for(const part of parts){const file=files[part],spki=await openingKey(session.fingerprints[part]);encrypted.push(await encryptPart(session.context,part,{name:file.name,type:file.type,data:new Uint8Array(await file.arrayBuffer())},spki,session.fingerprints[part]));}
     const result:BidBundle={protocol:PROTOCOL,context:session.context,parts:encrypted};await validateBundle(result);if(current()){setBundle(result);setStored('');}
    })}>Prepare encrypted package</button>
    <label>Or restore an encrypted package backup<input type="file" accept=".json,application/json" onChange={e=>{const file=e.target.files?.[0];if(!file)return;void run('Validating encrypted backup…',async(_w,current)=>{
     if(file.size>MAX_BUNDLE_BYTES)throw new Error('Backup exceeds 6 MiB.');const value=await validateBundle(JSON.parse(await file.text()));
     if(JSON.stringify(value.context)!==JSON.stringify(session.context))throw new Error('Backup belongs to a different bidder, tender, version or deployment.');if(current()){setBundle(value);setStored('');}
    });}}/></label>
   </fieldset>
  </>}
  {bundle&&session&&<div className="publication-review"><h3>Review encrypted bid</h3><p>Tender #{bundle.context.tenderId} · bid version {bundle.context.version}. Review these evidence digests before submitting.</p>
   {bundle.parts.map(part=><div className="bid-evidence" key={part.part}><strong>{['Initial','Technical','Financial'][part.part]}</strong><dl>{Object.entries(part.evidence).map(([label,value])=><div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl></div>)}
   <div className="bid-actions"><button className="button secondary" type="button" onClick={()=>saveEncrypted(bundle)}>Save encrypted backup</button>
   <button className="button secondary" type="button" disabled={busy||pendingActive||!ready||Boolean(stored)} onClick={()=>void run('Approve encrypted storage authorization in your wallet…',async(w,current)=>{const contentId=await uploadBid(w,session,bundle,current);if(current())setStored(contentId);})}>{stored?'Package stored':'Sign and upload encrypted package'}</button></div>
   {stored&&<><p>Stored package <code>{stored}</code>. This storage receipt does not mean the bid is accepted.</p><div className="bid-actions">
   <button className="button secondary" type="button" disabled={busy} onClick={()=>void run('Approve owner retrieval in your wallet…',async(w)=>{saveEncrypted(await retrieveBid(w,session.deployment,bundle,stored));})}>Retrieve and verify stored backup</button>
   <button className="button primary" type="button" disabled={busy||Boolean(pending)||!ready} onClick={()=>void run('Review and approve the bid transaction in your wallet…',async(w,current)=>{
    const tx=await submitEncryptedBid(w,session,bundle,stored,current);if(!mounted.current)return;setPending(tx);setConfirmed(null);setReverted(false);
    try{localStorage.setItem(pendingKey,JSON.stringify(tx));}catch{setMessage('Transaction submitted. Browser could not save tracking metadata; retain the transaction hash.');}
   })}>Sign and submit bid on blockchain</button></div></>}
  </div>}
  {pending&&<div className="publication-transaction" aria-live="polite"><strong>{confirmed!==null?'Bid transaction confirmed':reverted?'Bid transaction reverted':'Bid transaction submitted · confirmation pending'}</strong><p>Tender #{pending.context.tenderId} · version {pending.context.version}</p><code>{pending.hash}</code>
   {confirmed!==null&&<p>Matching BidSubmitted evidence confirmed in block {confirmed}. This is a submission receipt, not an award decision.</p>}
   {pendingActive&&<><p>Do not resubmit while confirmation is pending. The transaction hash is retained in this browser. Inspect replaced or dropped transactions in your wallet.</p><button type="button" className="button secondary" disabled={checking} onClick={()=>void check(pending)}>{checking?'Checking…':'Check bid confirmation'}</button></>}
   {(confirmed!==null||reverted)&&<button className="button secondary" type="button" onClick={()=>{setPending(null);setConfirmed(null);setReverted(false);try{localStorage.removeItem(pendingKey);}catch{}clearPrepared();}}>Prepare another bid version</button>}
  </div>}
 </section>;
}
