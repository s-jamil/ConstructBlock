import { BrowserProvider, Contract, Interface, ZeroAddress, ZeroHash, getAddress, id,
  type Eip1193Provider, type TransactionReceipt } from "ethers";
import type { ChainStatus } from "./api.ts";

export interface WalletProvider extends Eip1193Provider {
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
export interface PublicationForm {
  dossierDigest: string;
  deadline: string;
  commission: string;
  requiresTechnicalOffer: boolean;
  initialKey: string;
  technicalKey: string;
  financialKey: string;
}
export interface PublicationInput {
  dossierDigest: string;
  deadline: bigint;
  commission: string;
  requiresTechnicalOffer: boolean;
  keyFingerprints: [string, string, string];
}
export interface OfficerSession {
  account: string;
  chainId: string;
  injected: WalletProvider;
  deployment: ChainStatus;
}
export interface Submission {
  hash: string;
  officer: string;
  workflow: string;
  chainId: string;
  input: PublicationInput;
}
export interface PublicationReceipt { tenderId: string; transactionHash: string; blockNumber: number }
export class PublicationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "PublicationError"; this.code = code; }
}
export const registryAbi = [
  "function hasRole(bytes32 role,address account) view returns(bool)",
];
export const workflowAbi = [
  "function registry() view returns(address)",
  "function OPENING_POLICY_VERSION() view returns(uint8)",
  "function paused() view returns(bool)",
  "function publishTender(bytes32 dossierDigest,uint64 deadline,bool requiresTechnicalOffer,address commission,bytes32[3] keyFingerprints) returns(uint256)",
  "event TenderPublished(uint256 indexed tenderId,address indexed officer,address indexed commission,uint64 deadline,bool requiresTechnicalOffer,bytes32 dossierDigest,bytes32[3] openingKeyFingerprints)",
  "error Unauthorized()", "error InvalidInput()", "error PlatformPaused()",
];
const workflowInterface = new Interface(workflowAbi);
function nonzeroDigest(value: string, label: string) {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed) || trimmed.toLowerCase() === ZeroHash)
    throw new PublicationError("INVALID_FORM", `${label} must be a nonzero 32-byte hexadecimal hash (0x and 64 hex characters).`);
  return trimmed;
}
export function validatePublication(form: PublicationForm, now = Date.now()): PublicationInput {
  const millis = new Date(form.deadline).getTime();
  if (!form.deadline || !Number.isFinite(millis) || millis <= now)
    throw new PublicationError("INVALID_FORM", "Choose a valid submission deadline in the future.");
  const deadline = BigInt(Math.floor(millis / 1000));
  if (deadline <= BigInt(Math.floor(now / 1000)) || deadline >= 2n ** 64n)
    throw new PublicationError("INVALID_FORM", "The deadline must be a future uint64 timestamp.");
  let commission: string;
  try { commission = getAddress(form.commission.trim()); if (commission === ZeroAddress) throw new Error(); }
  catch { throw new PublicationError("INVALID_FORM", "Enter a nonzero commission wallet with a valid checksum or lowercase spelling."); }
  return {
    dossierDigest: nonzeroDigest(form.dossierDigest, "Dossier digest"), deadline, commission,
    requiresTechnicalOffer: form.requiresTechnicalOffer,
    keyFingerprints: [nonzeroDigest(form.initialKey, "Initial-part key fingerprint"),
      form.requiresTechnicalOffer ? nonzeroDigest(form.technicalKey, "Technical-offer key fingerprint") : ZeroHash,
      nonzeroDigest(form.financialKey, "Financial-offer key fingerprint")],
  };
}
function provider(injected: WalletProvider) {
  return new BrowserProvider(injected, "any", { cacheTimeout: -1 });
}
async function walletChain(injected: WalletProvider, deployment: ChainStatus) {
  const actual = await injected.request({ method: "eth_chainId" });
  if (typeof actual !== "string" || !/^0x[0-9a-f]+$/i.test(actual)
      || BigInt(actual).toString() !== deployment.chainId)
    throw new PublicationError("WRONG_CHAIN", `Switch your wallet to the configured chain ${deployment.chainId}, then reconnect.`);
}
async function verifyDeployment(p: BrowserProvider, deployment: ChainStatus) {
  const [registryCode, workflowCode] = await Promise.all([
    p.getCode(deployment.contracts.roleRegistry), p.getCode(deployment.contracts.procurementWorkflow),
  ]);
  if (registryCode === "0x" || workflowCode === "0x")
    throw new PublicationError("MISSING_CONTRACT", "The wallet network does not contain the configured contracts. Check its RPC and the backend deployment addresses.");
  const workflow = new Contract(deployment.contracts.procurementWorkflow, workflowAbi, p);
  try { if (await workflow.OPENING_POLICY_VERSION() !== 2n) throw new Error(); }
  catch { throw new PublicationError("WRONG_DEPLOYMENT", "Deploy opening policy 2 contracts and update configuration before publishing."); }
  if (getAddress(await workflow.registry()) !== getAddress(deployment.contracts.roleRegistry))
    throw new PublicationError("WRONG_DEPLOYMENT", "The wallet's procurement contract uses a different role registry.");
}
async function verifyAccount(injected: WalletProvider, expected: string) {
  const accounts = await injected.request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || !accounts[0] || getAddress(accounts[0]) !== expected)
    throw new PublicationError("WALLET_CHANGED", "The active wallet account changed. Reconnect and review the tender again.");
}
export async function connectOfficer(injected: WalletProvider, deployment: ChainStatus): Promise<OfficerSession> {
  const accounts = await injected.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || !accounts[0]) throw new PublicationError("NO_ACCOUNT", "No wallet account was selected.");
  const account = getAddress(accounts[0]);
  await walletChain(injected, deployment);
  const p = provider(injected);
  try {
    await verifyDeployment(p, deployment);
    const registry = new Contract(deployment.contracts.roleRegistry, registryAbi, p);
    if (!await registry.hasRole(id("OFFICER_ROLE"), account))
      throw new PublicationError("NOT_OFFICER", "This wallet does not have the government officer role. Ask the government administrator to grant it.");
    await verifyAccount(injected, account);
    return { account, chainId: deployment.chainId, injected, deployment };
  } finally { p.destroy(); }
}
export async function submitPublication(session: OfficerSession, input: PublicationInput,
    isCurrent: () => boolean = () => true): Promise<Submission> {
  const ensureCurrent = () => { if (!isCurrent()) throw new PublicationError("WALLET_CHANGED", "Wallet or deployment changed. Reconnect and review again."); };
  ensureCurrent();
  await walletChain(session.injected, session.deployment);
  await verifyAccount(session.injected, session.account);
  const p = provider(session.injected);
  try {
    await verifyDeployment(p, session.deployment);
    const registry = new Contract(session.deployment.contracts.roleRegistry, registryAbi, p);
    if (!await registry.hasRole(id("OFFICER_ROLE"), session.account))
      throw new PublicationError("NOT_OFFICER", "The government officer role is no longer assigned to this wallet.");
    if (!await registry.hasRole(id("COMMISSION_ROLE"), input.commission))
      throw new PublicationError("NOT_COMMISSION", "The commission wallet does not hold COMMISSION_ROLE in this registry.");
    const workflow = new Contract(session.deployment.contracts.procurementWorkflow, workflowAbi, await p.getSigner(session.account));
    if (await workflow.paused()) throw new PublicationError("PAUSED", "Government administration has paused procurement actions.");
    const block = await p.getBlock("latest");
    if (!block || input.deadline <= BigInt(block.timestamp))
      throw new PublicationError("DEADLINE_PASSED", "The deadline must also be later than the blockchain's current time. Check the development node clock.");
    const args = [input.dossierDigest, input.deadline, input.requiresTechnicalOffer, input.commission, input.keyFingerprints] as const;
    await workflow.publishTender.staticCall(...args);
    const gas = await workflow.publishTender.estimateGas(...args);
    ensureCurrent();
    await walletChain(session.injected, session.deployment);
    await verifyAccount(session.injected, session.account);
    ensureCurrent();
    // The wallet displays its own confirmation. No private key enters this app.
    const tx = await workflow.publishTender(...args, { gasLimit: gas * 120n / 100n });
    // Once broadcast, always return the hash even if the user changes accounts.
    return { hash: tx.hash, officer: session.account, workflow: session.deployment.contracts.procurementWorkflow,
      chainId: session.chainId, input };
  } finally { p.destroy(); }
}
export function parsePublicationReceipt(receipt: Pick<TransactionReceipt, "status" | "hash" | "blockNumber" | "logs">,
    submission: Submission): PublicationReceipt {
  if (receipt.hash.toLowerCase() !== submission.hash.toLowerCase())
    throw new PublicationError("WRONG_RECEIPT", "The receipt belongs to a different transaction.");
  if (receipt.status !== 1) throw new PublicationError("TRANSACTION_REVERTED", "The publication transaction was mined but reverted. No tender was published by this transaction.");
  const matches = receipt.logs.flatMap(log => {
    if (getAddress(log.address) !== getAddress(submission.workflow)) return [];
    try { const event = workflowInterface.parseLog(log); return event?.name === "TenderPublished" ? [event] : []; } catch { return []; }
  }).filter(event => getAddress(event.args.officer) === submission.officer
    && getAddress(event.args.commission) === submission.input.commission
    && event.args.dossierDigest.toLowerCase() === submission.input.dossierDigest.toLowerCase()
    && event.args.deadline === submission.input.deadline
    && event.args.requiresTechnicalOffer === submission.input.requiresTechnicalOffer
    && Array.from(event.args.openingKeyFingerprints as string[]).every((value, i) => value.toLowerCase() === submission.input.keyFingerprints[i].toLowerCase()));
  if (matches.length !== 1 || matches[0].args.tenderId <= 0n)
    throw new PublicationError("MISSING_PUBLICATION_EVENT", "The receipt does not contain the expected tender publication. Inspect this transaction in your wallet before retrying.");
  return { tenderId: matches[0].args.tenderId.toString(), transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
}
export async function checkPublication(injected: WalletProvider, submission: Submission): Promise<PublicationReceipt | null> {
  const actual = await injected.request({ method: "eth_chainId" });
  if (typeof actual !== "string" || !/^0x[0-9a-f]+$/i.test(actual) || BigInt(actual).toString() !== submission.chainId)
    throw new PublicationError("WRONG_CHAIN", `Switch the wallet back to chain ${submission.chainId} to check confirmation. Do not submit the tender again.`);
  const p = provider(injected);
  try {
    const receipt = await p.getTransactionReceipt(submission.hash);
    return receipt ? parsePublicationReceipt(receipt, submission) : null;
  } finally { p.destroy(); }
}
export function publicationMessage(error: unknown): string {
  if (error instanceof PublicationError) return error.message;
  const e = error as { code?: unknown; error?: { code?: unknown }; info?: { error?: { code?: unknown } } } | null;
  if ([e?.code, e?.error?.code, e?.info?.error?.code].some(code => code === 4001 || code === "ACTION_REJECTED"))
    return "The wallet request was declined. Nothing will be retried automatically.";
  if (e?.code === -32002) return "A wallet request is already open. Complete or decline it in your wallet.";
  return "The wallet request could not be completed. Check the account, network, balance and node, then try again.";
}
