import { getAddress, ZeroAddress } from "ethers";
export interface Health { status: "ok"; service: string; mode: "read-only" | "encrypted-storage" }
export interface ChainStatus { ready: true; chainId: string; expectedChainId: string; blockNumber: number; contracts: { roleRegistry: string; procurementWorkflow: string; registryLinked: true } }
export interface PublicTender { id: string; state: string; stateCode: number; deadlineTimestamp: string; deadlineIso: string | null; requiresTechnicalOffer: boolean; dossierDigest: string; publicExtractDigest: string | null; blockNumber: number }
export interface BidderStatus { address: string; approved: boolean; blockNumber: number }
export class ApiError extends Error {
 readonly code: string; readonly status: number;
 constructor(message: string, code = "NETWORK_UNAVAILABLE", status = 0) { super(message); this.name = "ApiError"; this.code = code; this.status = status; }
}
export function validateTenderId(value: string): string | null { return !/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) >= 2n ** 256n ? "Enter a positive whole-number tender ID, such as 1." : null; }
export function validateWalletAddress(value: string): string | null { try { if (getAddress(value) === ZeroAddress) throw new Error(); return null; } catch { return "Enter a nonzero Ethereum address with a valid checksum or lowercase spelling."; } }
export async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
 const timeout = AbortSignal.timeout(8000); const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
 let response: Response;
 try { response = await fetch(path, { method: "GET", headers: { Accept: "application/json" }, cache: "no-store", signal: combined }); }
 catch { if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError"); throw new ApiError(timeout.aborted ? "The request timed out. Check the backend and blockchain, then try again." : "Cannot reach the backend. Start the API on port 3001, then try again.", timeout.aborted ? "REQUEST_TIMEOUT" : "NETWORK_UNAVAILABLE"); }
 let body: unknown;
 try { body = await response.json(); } catch { throw new ApiError("The backend did not return valid JSON. Check that the API is running on port 3001.", "INVALID_RESPONSE", response.status); }
 if (!response.ok) { const error = (body as { error?: { code?: string; message?: string } })?.error; throw new ApiError(typeof error?.message === "string" ? error.message : "The request could not be completed.", typeof error?.code === "string" ? error.code : "API_ERROR", response.status); }
 return body as T;
}
function valid<T>(value: T, predicate: boolean): T { if (!predicate) throw new ApiError("The backend returned an unexpected response. Refresh or check the API configuration.", "INVALID_RESPONSE"); return value; }
const block = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const address = (value: unknown) => typeof value === "string" && validateWalletAddress(value) === null;
const digest = (value: unknown) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
export async function getHealth(signal?: AbortSignal) { const v = await requestJson<Health>("/health", signal); return valid(v, v?.status === "ok" && ["read-only", "encrypted-storage"].includes(v?.mode) && typeof v?.service === "string"); }
export async function getChainStatus(signal?: AbortSignal) { const v = await requestJson<ChainStatus>("/api/blockchain/status", signal); return valid(v, v?.ready === true && typeof v?.chainId === "string" && /^[1-9][0-9]*$/.test(v.chainId) && v.chainId === v.expectedChainId && block(v?.blockNumber) && v?.contracts?.registryLinked === true && address(v?.contracts?.roleRegistry) && address(v?.contracts?.procurementWorkflow)); }
export async function getTender(id: string, signal?: AbortSignal) { const error = validateTenderId(id); if (error) throw new ApiError(error, "INVALID_TENDER_ID", 400); const v = await requestJson<PublicTender>(`/api/tenders/${encodeURIComponent(id)}`, signal); const states = ["Open","Closed","InitialOpening","TechnicalReview","FinancialOpening","Selected","Approved","Cancelled","Unsuccessful","Rejected"]; return valid(v, v?.id === id && typeof v?.stateCode === "number" && Number.isInteger(v.stateCode) && v.stateCode >= 0 && v.stateCode < states.length && typeof v?.state === "string" && states[v.stateCode] === v.state && typeof v?.requiresTechnicalOffer === "boolean" && typeof v?.deadlineTimestamp === "string" && /^[0-9]+$/.test(v.deadlineTimestamp) && (v?.deadlineIso === null || typeof v?.deadlineIso === "string" && Number.isFinite(Date.parse(v.deadlineIso))) && digest(v?.dossierDigest) && (v?.publicExtractDigest === null || digest(v?.publicExtractDigest)) && block(v?.blockNumber)); }
export async function getBidderStatus(value: string, signal?: AbortSignal) { const error = validateWalletAddress(value); if (error) throw new ApiError(error, "INVALID_ADDRESS", 400); const v = await requestJson<BidderStatus>(`/api/bidders/${encodeURIComponent(value)}/status`, signal); return valid(v, address(v?.address) && v.address.toLowerCase() === value.toLowerCase() && typeof v?.approved === "boolean" && block(v?.blockNumber)); }
