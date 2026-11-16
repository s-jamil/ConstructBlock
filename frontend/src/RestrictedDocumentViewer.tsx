import {useEffect,useRef,useState} from 'react';
import type {GovernanceSnapshot} from './governance-client';
import type {WalletProvider} from './publication';
import {viewDocument,safeDownloadName,type ViewedDocument} from './document-client';
const parts=['Initial','Technical','Financial'];
export function RestrictedDocumentViewer({snapshot,disabled}:{snapshot:GovernanceSnapshot;disabled:boolean}){
 const [target,setTarget]=useState<{bidder:string;version:string;part:number}|null>(null),[doc,setDoc]=useState<ViewedDocument|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef(0),controller=useRef<AbortController|null>(null),documentRef=useRef<ViewedDocument|null>(null),lock=useRef(false);
 function clear(){generation.current++;controller.current?.abort();documentRef.current?.data.fill(0);documentRef.current=null;setDoc(null);setTarget(null);setMessage('');}
 useEffect(()=>{const w=(window as Window&{ethereum?:WalletProvider}).ethereum;const changed=()=>clear();w?.on?.('accountsChanged',changed);w?.on?.('chainChanged',changed);w?.on?.('disconnect',changed);
  return()=>{generation.current++;controller.current?.abort();documentRef.current?.data.fill(0);w?.removeListener?.('accountsChanged',changed);w?.removeListener?.('chainChanged',changed);w?.removeListener?.('disconnect',changed);};
 },[]);
 useEffect(()=>{clear();},[snapshot]);
 async function open(){
  if(lock.current||!target)return;const w=(window as Window&{ethereum?:WalletProvider}).ethereum;if(!w){setMessage('Connect a browser wallet.');return;}
  lock.current=true;setBusy(true);setMessage('');const version=generation.current,abort=new AbortController();controller.current=abort;
  try{const result=await viewDocument(w,snapshot,target.bidder,target.version,target.part,()=>generation.current===version,abort.signal);
   if(generation.current===version){documentRef.current=result;setDoc(result);}else result.data.fill(0);
  }catch(e){if(generation.current===version)setMessage(e instanceof Error?e.message:'Document access failed.');}
  finally{lock.current=false;setBusy(false);}
 }
 let text:string|null=null;if(doc?.type==='text/plain')try{text=new TextDecoder('utf-8',{fatal:true}).decode(doc.data);}catch{}
 return <section className="publication-review" aria-labelledby="document-heading"><h3 id="document-heading">Restricted bid documents</h3>
 <p>Only the assigned commission can request a verified part. Each wallet signature authorizes one document release and is audited. Final-approver roles alone do not grant access.</p>
 {!snapshot.isCommission?<p>Switch to the assigned commission wallet to view documents.</p>:<>
 <div className="bid-actions">{snapshot.bids.filter(b=>b.active).flatMap(b=>parts.map((name,part)=>{
  const eligible=b.outcomes[part]===1&&snapshot.openings[part]?.authorized&&[2,3,4,5,6,9].includes(snapshot.state)&&snapshot.state>=[2,3,4][part]&&(part===0||b.admitted)&&(part!==1||snapshot.requiresTechnicalOffer)&&(part!==2||!snapshot.requiresTechnicalOffer||b.technicalAccepted);
  return eligible?<button type="button" className="button secondary" key={b.address+part} disabled={disabled||busy||snapshot.paused} onClick={()=>{clear();setTarget({bidder:b.address,version:b.version,part});}}>Review {name.toLowerCase()} document · {b.address.slice(0,8)}… · v{b.version}</button>:null;
 }))}</div>
 {target&&<><p>Request {parts[target.part].toLowerCase()} document · tender #{snapshot.tenderId} · bidder <code>{target.bidder}</code> · version {target.version}.</p><p>Contents are confidential. An authorized download creates a local copy you must protect. Closing this view clears application references; it cannot revoke a saved copy.</p>
 {!doc&&<button type="button" className="button primary" disabled={disabled||busy||snapshot.paused} onClick={()=>void open()}>{busy?'Authorizing document…':'Sign and view this document'}</button>}</>}
 {doc&&<><p><strong>{doc.name}</strong> · {doc.data.length} bytes · authorization block {doc.blockNumber}</p><p>Audit request <code>{doc.requestId}</code></p>
 {text!==null?<pre className="restricted-document-text">{text}</pre>:<p>This file is available as a download. Active document content is not embedded in this page.</p>}
 <button type="button" className="button secondary" onClick={()=>{const url=URL.createObjectURL(new Blob([new Uint8Array(doc.data)],{type:'application/octet-stream'})),link=document.createElement('a');link.href=url;link.download=safeDownloadName(doc.name);link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>Download authorized document</button></>}
 {target&&<button type="button" className="button secondary" onClick={clear}>Close document</button>}
 </>}{message&&<p role="alert">{message}</p>}</section>;
}
