import { Contract, FetchRequest, JsonRpcProvider, id, ZeroHash, getAddress,
  type AbstractProvider, type Block } from "ethers";
import registryArtifact from "./abi/RoleRegistry.json" with { type: "json" };
import workflowArtifact from "./abi/ProcurementWorkflow.json" with { type: "json" };
import type { Config } from "./config.ts";
import type { OpeningRequest } from "./opening-protocol.ts";
import { ApiError } from "./errors.ts";
const states = ["Open", "Closed", "InitialOpening", "TechnicalReview", "FinancialOpening",
  "Selected", "Approved", "Cancelled", "Unsuccessful", "Rejected"];
export interface ChainStatus {
  ready: true; chainId: string; expectedChainId: string; blockNumber: number;
  contracts: { roleRegistry: string; procurementWorkflow: string; registryLinked: true };
}
export interface PublicTender {
  id: string; state: string; stateCode: number; deadlineTimestamp: string;
  deadlineIso: string | null; requiresTechnicalOffer: boolean; dossierDigest: string;
  publicExtractDigest: string | null; blockNumber: number;
}
export interface BidderStatus { address: string; approved: boolean; blockNumber: number }
export interface BlockchainReader {
  status(): Promise<ChainStatus>;
  tender(id: bigint): Promise<PublicTender>;
  bidderStatus(address: string): Promise<BidderStatus>;
}
export function createProvider(config: Config) {
  const request = new FetchRequest(config.rpcUrl); request.timeout = config.rpcTimeoutMs;
  // Never obtain a signer: this milestone only performs reads.
  return new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
}
export class BlockchainService implements BlockchainReader {
  readonly provider: AbstractProvider;
  private readonly config: Config;
  private readonly registry: Contract;
  private readonly workflow: Contract;
  constructor(config: Config, provider: AbstractProvider = createProvider(config)) {
    this.config = config; this.provider = provider;
    this.registry = new Contract(config.registryAddress, registryArtifact.abi, provider);
    this.workflow = new Contract(config.workflowAddress, workflowArtifact.abi, provider);
  }
  private async read<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(503, "RPC_TIMEOUT", "The blockchain request timed out.")), this.config.rpcTimeoutMs);
      })]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "BLOCKCHAIN_UNAVAILABLE", "Cannot read the configured blockchain. Check the node, deployment addresses and ABIs.");
    } finally { if (timer) clearTimeout(timer); }
  }
  private async snapshot(): Promise<Block> {
    const network = await this.provider.getNetwork();
    if (network.chainId !== this.config.chainId) throw new ApiError(503, "CHAIN_MISMATCH", "The connected chain ID does not match configuration.",
      { expectedChainId: this.config.chainId.toString(), actualChainId: network.chainId.toString() });
    const block = await this.provider.getBlock("latest");
    if (!block) throw new ApiError(503, "BLOCKCHAIN_UNAVAILABLE", "The blockchain has no readable latest block.");
    const [registryCode, workflowCode] = await Promise.all([
      this.provider.getCode(this.config.registryAddress, block.number), this.provider.getCode(this.config.workflowAddress, block.number),
    ]);
    if (registryCode === "0x" || workflowCode === "0x") throw new ApiError(503, "CONTRACT_NOT_DEPLOYED",
      "A configured contract is missing. Redeploy after a node reset and update backend/.env.");
    const [linkedRegistry, bidderRole] = await Promise.all([
      this.workflow.registry({ blockTag: block.number }), this.registry.BIDDER_ROLE({ blockTag: block.number }),
    ]);
    if (getAddress(linkedRegistry) !== this.config.registryAddress || bidderRole !== id("BIDDER_ROLE"))
      throw new ApiError(503, "CONTRACT_MISMATCH", "The deployed contracts do not match the configured registry pair.");
    try {
      if (await this.workflow.OPENING_POLICY_VERSION({ blockTag: block.number }) !== 2n) throw new Error();
    } catch {
      throw new ApiError(503, "OPENING_POLICY_MISMATCH", "This app requires commission-authorized opening policy 2. Deploy the revised contracts and update the configured addresses.");
    }
    return block;
  }
  status(): Promise<ChainStatus> {
    return this.read(async () => {
      const block = await this.snapshot();
      return { ready: true, chainId: this.config.chainId.toString(), expectedChainId: this.config.chainId.toString(),
        blockNumber: block.number, contracts: { roleRegistry: this.config.registryAddress,
          procurementWorkflow: this.config.workflowAddress, registryLinked: true } };
    });
  }
  tender(tenderId: bigint): Promise<PublicTender> {
    return this.read(async () => {
      const block = await this.snapshot();
      const count: bigint = await this.workflow.tenderCount({ blockTag: block.number });
      if (tenderId > count) throw new ApiError(404, "TENDER_NOT_FOUND", "No tender exists with this ID.");
      const tender = await this.workflow.getTender(tenderId, { blockTag: block.number });
      const stateCode = Number(tender.state);
      if (!Number.isInteger(stateCode) || !states[stateCode]) throw new ApiError(503, "CONTRACT_MISMATCH", "The contract returned an unsupported tender state.");
      const millis = Number(tender.deadline) * 1000;
      const deadlineIso = millis <= 8640000000000000 ? new Date(millis).toISOString() : null;
      // Explicit allowlist: no commission identity, review counts, selection,
      // restricted evidence digests or bid documents are returned here.
      return { id: tenderId.toString(), state: states[stateCode], stateCode,
        deadlineTimestamp: tender.deadline.toString(), deadlineIso,
        requiresTechnicalOffer: tender.requiresTechnicalOffer, dossierDigest: tender.dossierDigest,
        publicExtractDigest: tender.publicExtractDigest === ZeroHash ? null : tender.publicExtractDigest,
        blockNumber: block.number };
    });
  }
  bidAccess(tenderId: bigint, address: string) {
    return this.read(async () => {
      const block = await this.snapshot();
      if (tenderId > await this.workflow.tenderCount({ blockTag: block.number }))
        throw new ApiError(404, "TENDER_NOT_FOUND", "No tender exists with this ID.");
      const [tender, bid, paused, events] = await Promise.all([
        this.workflow.getTender(tenderId, { blockTag: block.number }),
        this.workflow.getBid(tenderId, address, { blockTag: block.number }),
        this.workflow.paused({ blockTag: block.number }),
        this.workflow.queryFilter(this.workflow.filters.TenderPublished(tenderId), 0, block.number),
      ]);
      if (events.length !== 1 || !("args" in events[0]))
        throw new ApiError(503, "PUBLICATION_MISSING", "Cannot verify the tender opening keys.");
      return { state: Number(tender.state), deadline: tender.deadline.toString(), chainTime: block.timestamp,
        version: bid.version.toString(), active: Boolean(bid.active), paused: Boolean(paused),
        requiresTechnicalOffer: Boolean(tender.requiresTechnicalOffer),
        fingerprints: Array.from(events[0].args.openingKeyFingerprints as string[]) };
    });
  }
  openingAccess(request: OpeningRequest) {
    return this.read(async () => {
      const block = await this.snapshot(), c = request.context;
      if(c.chainId !== this.config.chainId.toString() || c.workflow !== this.config.workflowAddress.toLowerCase())
        throw new ApiError(409, "DEPLOYMENT_MISMATCH", "Opening request belongs to a different deployment.");
      if(!await this.registry.hasRole(id("OPENING_SERVICE_ROLE"),request.service,{blockTag:block.number}))
        throw new ApiError(403,"NOT_OPENING_SERVICE","The signer does not hold OPENING_SERVICE_ROLE.");
      if(BigInt(c.tenderId) > await this.workflow.tenderCount({blockTag:block.number}))
        throw new ApiError(404,"TENDER_NOT_FOUND","No tender exists with this ID.");
      const options={blockTag:block.number};
      const [t,b,o,outcome,paused,e,events]=await Promise.all([
        this.workflow.getTender(c.tenderId,options),this.workflow.getBid(c.tenderId,c.bidder,options),
        this.workflow.getOpening(c.tenderId,request.part,options),this.workflow.getOutcome(c.tenderId,c.bidder,request.part,options),
        this.workflow.paused(options),this.workflow.getEvidence(c.tenderId,c.bidder,c.version,request.part,options),
        this.workflow.queryFilter(this.workflow.filters.TenderPublished(c.tenderId),0,block.number),
      ]);
      if(paused || Number(t.state)!==[2,3,4][request.part] || BigInt(t.deadline)>BigInt(block.timestamp)
        || !o.requested || !o.authorized)
        throw new ApiError(403,"OPENING_NOT_AUTHORIZED","The requested stage lacks commission authorization or is not active.");
      if(!b.active || b.version.toString()!==c.version || Number(outcome)!==0
        || (request.part!==0 && !b.admitted) || (request.part===1 && !t.requiresTechnicalOffer)
        || (request.part===2 && t.requiresTechnicalOffer && !b.technicalAccepted))
        throw new ApiError(409,"BID_NOT_OPENABLE","The bid version is inactive, ineligible or already processed.");
      if(events.length!==1 || !("args" in events[0]))
        throw new ApiError(503,"PUBLICATION_MISSING","Cannot verify published opening keys.");
      return {blockNumber:block.number,fingerprint:String(events[0].args.openingKeyFingerprints[request.part]).toLowerCase(),
        evidence:{commitment:String(e.commitment),ciphertextHash:String(e.ciphertextHash),wrappedPackageHash:String(e.wrappedPackageHash)}};
    });
  }
  documentAccess(request: import('./document-protocol.ts').DocumentRequest) {
    return this.read(async()=>{
      const block=await this.snapshot(),c=request.context,options={blockTag:block.number};
      if(c.chainId!==this.config.chainId.toString()||c.workflow!==this.config.workflowAddress.toLowerCase())
        throw new ApiError(409,'DEPLOYMENT_MISMATCH','Document belongs to a different deployment.');
      if(BigInt(c.tenderId)>await this.workflow.tenderCount(options))throw new ApiError(404,'TENDER_NOT_FOUND','No tender exists with this ID.');
      const [t,b,o,outcome,paused,role,e,events]=await Promise.all([
        this.workflow.getTender(c.tenderId,options),this.workflow.getBid(c.tenderId,c.bidder,options),
        this.workflow.getOpening(c.tenderId,request.part,options),this.workflow.getOutcome(c.tenderId,c.bidder,request.part,options),
        this.workflow.paused(options),this.registry.hasRole(id('COMMISSION_ROLE'),request.viewer,options),
        this.workflow.getEvidence(c.tenderId,c.bidder,c.version,request.part,options),
        this.workflow.queryFilter(this.workflow.filters.TenderPublished(c.tenderId),0,block.number),
      ]);
      if(!role||t.commission.toLowerCase()!==request.viewer)throw new ApiError(403,'NOT_DOCUMENT_REVIEWER','Only the currently assigned commission wallet can view documents.');
      if(paused||![2,3,4,5,6,9].includes(Number(t.state))||Number(t.state)<[2,3,4][request.part]||BigInt(t.deadline)>BigInt(block.timestamp)
        ||!o.requested||!o.authorized)
        throw new ApiError(403,'DOCUMENT_STAGE_LOCKED','Document viewing is not authorized at this stage.');
      if(!b.active||b.version.toString()!==c.version||Number(outcome)!==1||(request.part!==0&&!b.admitted)
        ||(request.part===1&&!t.requiresTechnicalOffer)||(request.part===2&&t.requiresTechnicalOffer&&!b.technicalAccepted))
        throw new ApiError(409,'DOCUMENT_NOT_VERIFIED','Only an eligible current bid part with a Verified outcome can be viewed.');
      if(events.length!==1||!('args' in events[0]))throw new ApiError(503,'PUBLICATION_MISSING','Cannot verify published opening keys.');
      return {blockNumber:block.number,fingerprint:String(events[0].args.openingKeyFingerprints[request.part]).toLowerCase(),
        evidence:{commitment:String(e.commitment),ciphertextHash:String(e.ciphertextHash),wrappedPackageHash:String(e.wrappedPackageHash)}};
    });
  }
  bidderStatus(address: string): Promise<BidderStatus> {
    return this.read(async () => {
      const block = await this.snapshot();
      const approved: boolean = await this.registry.hasRole(id("BIDDER_ROLE"), address, { blockTag: block.number });
      return { address, approved, blockNumber: block.number };
    });
  }
}
