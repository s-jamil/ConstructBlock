import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChainStatus } from "./api";
import { connectOfficer, submitPublication, checkPublication, validatePublication, publicationMessage,
  type WalletProvider, type OfficerSession, type PublicationForm, type PublicationInput,
  type Submission, type PublicationReceipt } from "./publication";

const emptyForm: PublicationForm = { dossierDigest: "", deadline: "", commission: "",
  requiresTechnicalOffer: false, initialKey: "", technicalKey: "", financialKey: "" };
type Props = { deployment?: ChainStatus; ready: boolean; onViewTender: (id: string) => void };
function injectedWallet(): WalletProvider | undefined {
  return (window as Window & { ethereum?: WalletProvider }).ethereum;
}
export function OfficerPublication({ deployment, ready, onViewTender }: Props) {
  const [session, setSession] = useState<OfficerSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState<PublicationForm>(emptyForm);
  const [review, setReview] = useState<PublicationInput | null>(null);
  const [phase, setPhase] = useState<"idle" | "signature" | "pending" | "confirmed" | "failed">("idle");
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [receipt, setReceipt] = useState<PublicationReceipt | null>(null);
  const [checking, setChecking] = useState(false);
  const epoch = useRef(0), mounted = useRef(true), polling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const confirmationLock = useRef(false);
  const busy = phase === "signature" || phase === "pending";
  const injected = useRef<WalletProvider | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    injected.current = injectedWallet();
    const invalidate = () => {
      epoch.current += 1; setSession(null); setReview(null); setConnecting(false);
      setMessage("Wallet account or network changed. Reconnect to verify officer access. A submitted transaction is still tracked below.");
    };
    const wallet = injected.current;
    wallet?.on?.("accountsChanged", invalidate); wallet?.on?.("chainChanged", invalidate); wallet?.on?.("disconnect", invalidate);
    return () => {
      mounted.current = false; epoch.current += 1;
      wallet?.removeListener?.("accountsChanged", invalidate); wallet?.removeListener?.("chainChanged", invalidate); wallet?.removeListener?.("disconnect", invalidate);
      if (polling.current) clearTimeout(polling.current);
    };
  }, []);
  useEffect(() => { epoch.current += 1; setSession(null); setReview(null); },
    [deployment?.chainId, deployment?.contracts.roleRegistry, deployment?.contracts.procurementWorkflow]);
  async function connect() {
    if (!deployment || !ready) return;
    const wallet = injectedWallet(); injected.current = wallet;
    if (!wallet) { setMessage("No browser wallet was detected. Open this app in a browser with an Ethereum wallet extension, then refresh."); return; }
    const version = ++epoch.current; setConnecting(true); setMessage("");
    try {
      const result = await connectOfficer(wallet, deployment);
      if (mounted.current && epoch.current === version) setSession(result);
    } catch (error) { if (mounted.current && epoch.current === version) setMessage(publicationMessage(error)); }
    finally { if (mounted.current && epoch.current === version) setConnecting(false); }
  }
  function field<K extends keyof PublicationForm>(name: K, value: PublicationForm[K]) {
    setForm(previous => ({ ...previous, [name]: value })); setReview(null); setMessage("");
  }
  function reviewTender(event: FormEvent) {
    event.preventDefault(); setMessage("");
    try { setReview(validatePublication(form)); } catch (error) { setReview(null); setMessage(publicationMessage(error)); }
  }
  async function confirm(pending: Submission, automatic = false) {
    const wallet = injected.current;
    if (!wallet || confirmationLock.current) return;
    confirmationLock.current = true; setChecking(true);
    try {
      const confirmed = await checkPublication(wallet, pending);
      if (!mounted.current) return;
      if (confirmed) { setReceipt(confirmed); setPhase("confirmed"); setMessage(""); }
      else if (!automatic) setMessage("This transaction is not confirmed yet. Check your wallet activity. Do not submit the same tender again.");
    } catch (error) {
      if (!mounted.current) return;
      if ((error as { code?: string }).code === "TRANSACTION_REVERTED") setPhase("failed");
      setMessage(publicationMessage(error));
    } finally { confirmationLock.current = false; if (mounted.current) setChecking(false); }
  }
  useEffect(() => {
    if (phase !== "pending" || !submission) return;
    let cancelled = false, attempts = 0;
    async function tick() {
      if (cancelled) return;
      await confirm(submission!, true); attempts += 1;
      if (!cancelled && attempts < 40) polling.current = setTimeout(tick, 1500);
    }
    void tick();
    return () => { cancelled = true; if (polling.current) clearTimeout(polling.current); };
  }, [phase, submission]);
  async function signAndPublish() {
    if (!session || !review || !ready || busy) return;
    const version = epoch.current; setMessage(""); setPhase("signature");
    try {
      const result = await submitPublication(session, review, () => mounted.current && epoch.current === version);
      if (mounted.current) { setSubmission(result); setReceipt(null); setPhase("pending"); }
    } catch (error) { if (mounted.current) { setPhase("idle"); setMessage(publicationMessage(error)); } }
  }
  return <section className="panel officer-panel" id="officer-publication" aria-labelledby="publication-heading">
    <div className="panel-heading"><div><h2 id="publication-heading">Publish a tender</h2><p>Government officer action · signed by your wallet</p></div><span className="tag">Officer workspace</span></div>
    <p className="publication-intro">Connect an approved officer wallet to publish. Your private key stays in the wallet. This connection does not create a backend login session.</p>
    {!ready && <p className="connection-notice">Blockchain readiness must be verified before connecting or publishing.</p>}
    <div className="officer-wallet-row">
      {session ? <div><strong>Officer role verified</strong><code>{session.account}</code><span>Chain {session.chainId}</span></div> : <p>No officer wallet verified.</p>}
      <button className="button secondary" type="button" onClick={() => void connect()} disabled={!ready || connecting || busy}>
        {connecting ? "Verify in wallet…" : session ? "Recheck officer wallet" : "Connect officer wallet"}
      </button>
    </div>
    {message && <p className="publication-message" role="alert">{message}</p>}
    {session && !receipt && <form onSubmit={reviewTender} noValidate>
      <fieldset disabled={busy || !ready} className="publication-fields">
        <legend>Tender configuration</legend>
        <label htmlFor="publish-dossier">Published dossier SHA-256 digest<input id="publish-dossier" value={form.dossierDigest} onChange={e => field("dossierDigest", e.target.value)} placeholder="0x + 64 hexadecimal characters" maxLength={66} spellCheck={false}/></label>
        <label htmlFor="publish-deadline">Submission deadline · your local time<input id="publish-deadline" type="datetime-local" value={form.deadline} onChange={e => field("deadline", e.target.value)}/></label>
        <label htmlFor="publish-commission">Assigned commission wallet<input id="publish-commission" value={form.commission} onChange={e => field("commission", e.target.value)} placeholder="0x…" maxLength={42} spellCheck={false}/><small>Must hold COMMISSION_ROLE in the connected registry.</small></label>
        <label htmlFor="publish-initial-key">Initial-part public key fingerprint<input id="publish-initial-key" value={form.initialKey} onChange={e => field("initialKey", e.target.value)} maxLength={66} placeholder="0x + 64 hexadecimal characters" spellCheck={false}/></label>
        <label htmlFor="publish-financial-key">Financial-offer public key fingerprint<input id="publish-financial-key" value={form.financialKey} onChange={e => field("financialKey", e.target.value)} maxLength={66} placeholder="0x + 64 hexadecimal characters" spellCheck={false}/></label>
        <label className="publication-checkbox" htmlFor="publish-technical-required"><input id="publish-technical-required" type="checkbox" checked={form.requiresTechnicalOffer} onChange={e => field("requiresTechnicalOffer", e.target.checked)}/>Require a separate technical offer</label>
        {form.requiresTechnicalOffer && <label htmlFor="publish-technical-key">Technical-offer public key fingerprint<input id="publish-technical-key" value={form.technicalKey} onChange={e => field("technicalKey", e.target.value)} maxLength={66} placeholder="0x + 64 hexadecimal characters" spellCheck={false}/></label>}
        <p className="publication-help">Use fingerprints of the government's actual public opening keys. Do not enter documents, private keys, passwords or bid contents. This form does not upload or generate opening keys.</p>
        <button className="button primary" type="submit">Review publication</button>
      </fieldset>
    </form>}
    {review && session && phase === "idle" && ready && <div className="publication-review" aria-label="Review before signing">
      <h3>Review before signing</h3><dl>
        <dt>Officer</dt><dd><code>{session.account}</code></dd>
        <dt>Commission</dt><dd><code>{review.commission}</code></dd>
        <dt>Deadline in UTC</dt><dd>{new Date(Number(review.deadline) * 1000).toISOString()}</dd>
        <dt>Separate technical offer</dt><dd>{review.requiresTechnicalOffer ? "Required" : "Not required"}</dd>
        <dt>Dossier digest</dt><dd><code>{review.dossierDigest}</code></dd>
        {review.keyFingerprints.map((value, i) => <div key={i}><dt>{["Initial", "Technical", "Financial"][i]} key fingerprint</dt><dd><code>{value}</code></dd></div>)}
      </dl><p>Publishing creates a new on-chain tender. Review the values and the wallet's transaction details; published tender configuration cannot be edited in this version.</p>
      <button className="button primary" type="button" onClick={() => void signAndPublish()}>Sign and publish tender</button>
    </div>}
    {phase === "signature" && <p role="status" className="publication-message">Complete or decline the publication request in your wallet. No automatic retry will be made.</p>}
    {submission && <div className="publication-transaction" aria-live="polite">
      <strong>{phase === "confirmed" ? "Tender publication confirmed" : phase === "failed" ? "Transaction reverted" : "Transaction submitted · confirmation pending"}</strong>
      <code>{receipt?.transactionHash ?? submission.hash}</code>
      {phase === "pending" && <><p>Keep this page open. Changing accounts or closing the page does not cancel a submitted transaction. If you speed up or replace it, check the replacement in your wallet.</p><button type="button" className="button secondary" disabled={checking} onClick={() => void confirm(submission)}>{checking ? "Checking confirmation…" : "Check confirmation"}</button></>}
      {receipt && <><p>Tender #{receipt.tenderId} · confirmed in block #{receipt.blockNumber}</p><button className="button primary" type="button" onClick={() => onViewTender(receipt.tenderId)}>View tender #{receipt.tenderId}</button></>}
      {(phase === "confirmed" || phase === "failed") && <button className="button secondary" type="button" onClick={() => { setReceipt(null); setSubmission(null); setPhase("idle"); setReview(null); setForm(emptyForm); setMessage(""); }}>Start a new tender</button>}
    </div>}
  </section>;
}
