import assert from "node:assert/strict";
import { describe, it } from "mocha";
import hre from "hardhat";

const { ethers } = await hre.network.create();
const H = ethers.id("synthetic digest"), ZERO = ethers.ZeroHash;
const E = { commitment: H, ciphertextHash: ethers.id("ciphertext"), wrappedPackageHash: ethers.id("wrapped") };
const EMPTY = { commitment: ZERO, ciphertextHash: ZERO, wrappedPackageHash: ZERO };
const INITIAL = 0, TECHNICAL = 1, FINANCIAL = 2;
async function tx(p: Promise<any>) { await (await p).wait(); }
async function fails(action: () => Promise<any>, contract: any, expected: string) {
  try { const r = await action(); if (r?.wait) await r.wait(); }
  catch (e: any) {
    const data = e.data ?? e.error?.data;
    assert.equal(typeof data, "string", `Expected ${expected}; got ${String(e)}`);
    assert.equal(contract.interface.parseError(data)?.name, expected); return;
  }
  assert.fail(`Expected ${expected} revert`);
}
async function fixture(technical = false) {
  const [government, officer, commission, c1, c2, service, approver, bidder, bidder2, outsider, c3] = await ethers.getSigners();
  const registry: any = await ethers.deployContract("RoleRegistry", [government.address, 86400]);
  await registry.waitForDeployment();
  for (const [role, actor] of [
    [await registry.OFFICER_ROLE(), officer], [await registry.COMMISSION_ROLE(), commission], [await registry.OPENING_SERVICE_ROLE(), service],
    [await registry.APPROVAL_ROLE(), approver],
  ] as const) await tx(registry.grantRole(role, actor.address));
  await tx(registry.approveBidder(bidder.address)); await tx(registry.approveBidder(bidder2.address));
  const workflow: any = await ethers.deployContract("ProcurementWorkflow", [await registry.getAddress()]);
  await workflow.waitForDeployment();
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
  await tx(workflow.connect(officer).publishTender(H, deadline, technical, commission.address, [H, technical ? H : ZERO, H]));
  return { government, officer, commission, c1, c2, c3, service, approver, bidder, bidder2, outsider, registry, workflow, deadline, technical };
}
async function submit(f: any, bidder = f.bidder, version = 1) {
  await tx(f.workflow.connect(bidder).submitBid(1, version, E, f.technical ? E : EMPTY, E));
}
async function close(f: any) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [f.deadline]);
  await tx(f.workflow.connect(f.commission).closeTender(1));
}
async function open(f: any, part: number) {
  await tx(f.workflow.connect(f.commission).requestOpening(1, part));
  assert.equal((await f.workflow.getOpening(1, part)).authorized, true);
}
async function result(f: any, part: number, verified = true, bidder = f.bidder, version = 1) {
  await tx(f.workflow.connect(f.service).recordOpeningResult(1, bidder.address, version, part, verified, H));
}
async function initial(f: any) {
  await submit(f); await close(f); await open(f, INITIAL); await result(f, INITIAL);
  await tx(f.workflow.connect(f.commission).recordAdmission(1, f.bidder.address, true, H));
}
async function select(f: any) {
  await initial(f);
  if (f.technical) {
    await open(f, TECHNICAL); await result(f, TECHNICAL);
    await tx(f.workflow.connect(f.commission).recordTechnicalDecision(1, f.bidder.address, true, H));
  }
  await open(f, FINANCIAL); await result(f, FINANCIAL);
  await tx(f.workflow.connect(f.commission).selectBidder(1, f.bidder.address, H));
}

describe("Government role administration", function () {
  it("starts with the supplied government as administrator", async function () {
    const f = await fixture(); assert.equal(await f.registry.defaultAdmin(), f.government.address);
    assert.equal(await f.registry.hasRole(ZERO, f.bidder.address), false);
  });
  it("lets government approve and revoke bidders", async function () {
    const f = await fixture(); await tx(f.registry.revokeBidder(f.bidder.address));
    assert.equal(await f.registry.hasRole(await f.registry.BIDDER_ROLE(), f.bidder.address), false);
    await tx(f.registry.approveBidder(f.bidder.address));
    assert.equal(await f.registry.hasRole(await f.registry.BIDDER_ROLE(), f.bidder.address), true);
  });
  it("prevents a bidder granting itself officer rights", async function () {
    const f = await fixture(); const role = await f.registry.OFFICER_ROLE();
    await fails(() => f.registry.connect(f.bidder).grantRole(role, f.bidder.address), f.registry, "AccessControlUnauthorizedAccount");
  });
  it("prevents outsiders approving bidders", async function () {
    const f = await fixture(); await fails(() => f.registry.connect(f.outsider).approveBidder(f.outsider.address), f.registry, "AccessControlUnauthorizedAccount");
  });
  it("rejects zero addresses and unknown roles", async function () {
    const f = await fixture(); await fails(() => f.registry.approveBidder(ethers.ZeroAddress), f.registry, "ZeroAddress");
    await fails(() => f.registry.grantRole(H, f.bidder.address), f.registry, "UnsupportedRole");
  });
  it("prevents abandoning government administration", async function () {
    const f = await fixture(); await fails(() => f.registry.beginDefaultAdminTransfer(ethers.ZeroAddress), f.registry, "ZeroAddress");
    await fails(() => f.registry.renounceRole(ZERO, f.government.address), f.registry, "GovernmentAdministrationRequired");
  });
  it("transfers administration through delayed acceptance", async function () {
    const f = await fixture(); await tx(f.registry.beginDefaultAdminTransfer(f.outsider.address));
    assert.equal(await f.registry.defaultAdmin(), f.government.address);
    const [, schedule] = await f.registry.pendingDefaultAdmin();
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(schedule) + 1]);
    await tx(f.registry.connect(f.outsider).acceptDefaultAdminTransfer());
    assert.equal(await f.registry.defaultAdmin(), f.outsider.address);
    await fails(() => f.registry.approveBidder(f.officer.address), f.registry, "AccessControlUnauthorizedAccount");
  });
});

describe("Publication and confidential bid evidence", function () {
  it("publishes an open tender with an assigned commission", async function () {
    const f = await fixture(); const t = await f.workflow.getTender(1);
    assert.equal(t.state, 0n); assert.equal(t.officer, f.officer.address); assert.equal(t.commission, f.commission.address);
  });
  it("rejects unknown tender IDs", async function () {
    const f = await fixture(); await fails(() => f.workflow.getTender(0), f.workflow, "UnknownTender");
  });
  it("blocks publication by a bidder", async function () {
    const f = await fixture(); await fails(() => f.workflow.connect(f.bidder).publishTender(H, f.deadline, false, f.commission.address, [H, ZERO, H]), f.workflow, "Unauthorized");
  });
  it("requires a future deadline and required key fingerprints", async function () {
    const f = await fixture();
    await fails(() => f.workflow.connect(f.officer).publishTender(H, 1, false, f.commission.address, [H, ZERO, H]), f.workflow, "InvalidInput");
    await fails(() => f.workflow.connect(f.officer).publishTender(H, f.deadline, true, f.commission.address, [H, ZERO, H]), f.workflow, "InvalidInput");
  });
  it("preserves old commitments when replacing a bid", async function () {
    const f = await fixture(); await submit(f); await submit(f, f.bidder, 2);
    assert.equal((await f.workflow.getBid(1, f.bidder.address)).version, 2n);
    assert.equal((await f.workflow.getTender(1)).activeBids, 1n);
    assert.equal((await f.workflow.getEvidence(1, f.bidder.address, 1, INITIAL)).commitment, H);
  });
  it("rejects unapproved and revoked bidders", async function () {
    const f = await fixture(); await fails(() => f.workflow.connect(f.outsider).submitBid(1, 1, E, EMPTY, E), f.workflow, "Unauthorized");
    await tx(f.registry.revokeBidder(f.bidder.address));
    await fails(() => f.workflow.connect(f.bidder).submitBid(1, 1, E, EMPTY, E), f.workflow, "Unauthorized");
  });
  it("requires complete required parts and rejects unexpected technical evidence", async function () {
    const f = await fixture(); await fails(() => f.workflow.connect(f.bidder).submitBid(1, 1, EMPTY, EMPTY, E), f.workflow, "InvalidInput");
    await fails(() => f.workflow.connect(f.bidder).submitBid(1, 1, E, E, E), f.workflow, "InvalidInput");
    const g = await fixture(true); await fails(() => g.workflow.connect(g.bidder).submitBid(1, 1, E, EMPTY, E), g.workflow, "InvalidInput");
  });
  it("rejects replayed or skipped versions", async function () {
    const f = await fixture(); await submit(f);
    for (const version of [1, 3]) await fails(() => f.workflow.connect(f.bidder).submitBid(1, version, E, EMPTY, E), f.workflow, "InvalidBid");
  });
  it("withdraws only the caller's own bid and allows resubmission", async function () {
    const f = await fixture(); await submit(f); await fails(() => f.workflow.connect(f.bidder2).withdrawBid(1), f.workflow, "InvalidBid");
    await tx(f.workflow.connect(f.bidder).withdrawBid(1)); assert.equal((await f.workflow.getTender(1)).activeBids, 0n);
    await submit(f, f.bidder, 2); assert.equal((await f.workflow.getTender(1)).activeBids, 1n);
  });
  it("rejects submission exactly at the deadline", async function () {
    const f = await fixture(); await ethers.provider.send("evm_setNextBlockTimestamp", [f.deadline]);
    await fails(() => f.workflow.connect(f.bidder).submitBid(1, 1, E, EMPTY, E), f.workflow, "DeadlineViolation");
  });
  it("rejects withdrawal at the deadline without waiting for explicit closure", async function () {
    const f = await fixture(); await submit(f); await ethers.provider.send("evm_setNextBlockTimestamp", [f.deadline]);
    await fails(() => f.workflow.connect(f.bidder).withdrawBid(1), f.workflow, "DeadlineViolation");
  });
  it("prevents early closure and unassigned commission actions", async function () {
    const f = await fixture(); await fails(() => f.workflow.connect(f.commission).closeTender(1), f.workflow, "DeadlineViolation");
    await tx(f.registry.grantRole(await f.registry.COMMISSION_ROLE(), f.outsider.address));
    await fails(() => f.workflow.connect(f.outsider).closeTender(1), f.workflow, "Unauthorized");
  });
});

describe("Government opening and evaluation", function () {
  it("authorizes initial opening immediately on the assigned commission request", async function () {
    const f = await fixture(); await submit(f); await close(f);
    await fails(() => f.workflow.connect(f.service).recordOpeningResult(1, f.bidder.address, 1, INITIAL, true, H), f.workflow, "WrongState");
    await open(f, INITIAL);
    assert.equal(await f.workflow.OPENING_POLICY_VERSION(), 2n);
    assert.equal((await f.workflow.getTender(1)).state, 2n);
    assert.equal((await f.workflow.getTender(1)).pendingOpenings, 1n);
    await result(f, INITIAL);
  });
  it("rejects opening requests before deadline and before closure", async function () {
    const f = await fixture(); await submit(f);
    await fails(() => f.workflow.connect(f.commission).requestOpening(1, INITIAL), f.workflow, "DeadlineViolation");
    await ethers.provider.send("evm_setNextBlockTimestamp", [f.deadline]);
    await fails(() => f.workflow.connect(f.commission).requestOpening(1, INITIAL), f.workflow, "WrongState");
  });
  it("blocks government, service, bidders, outsiders and unassigned commissions from opening", async function () {
    const f = await fixture(); await submit(f); await close(f);
    await tx(f.registry.grantRole(await f.registry.COMMISSION_ROLE(), f.outsider.address));
    for (const actor of [f.government, f.service, f.bidder, f.c1, f.outsider])
      await fails(() => f.workflow.connect(actor).requestOpening(1, INITIAL), f.workflow, "Unauthorized");
  });
  it("rejects duplicate requests and opening with a revoked commission role", async function () {
    const f = await fixture(); await submit(f); await close(f);
    await tx(f.registry.revokeRole(await f.registry.COMMISSION_ROLE(), f.commission.address));
    await fails(() => f.workflow.connect(f.commission).requestOpening(1, INITIAL), f.workflow, "Unauthorized");
    await tx(f.registry.grantRole(await f.registry.COMMISSION_ROLE(), f.commission.address));
    await open(f, INITIAL);
    await fails(() => f.workflow.connect(f.commission).requestOpening(1, INITIAL), f.workflow, "InvalidOpening");
  });
  it("removes the legacy custodian role and approval function", async function () {
    const f = await fixture();
    await fails(() => f.registry.grantRole(ethers.id("CUSTODIAN_ROLE"), f.c1.address), f.registry, "UnsupportedRole");
    assert.equal(f.workflow.interface.getFunction("approveOpening"), null);
  });
  it("rejects an unauthorized opening service", async function () {
    const f = await fixture(); await submit(f); await close(f); await open(f, INITIAL);
    await fails(() => f.workflow.connect(f.officer).recordOpeningResult(1, f.bidder.address, 1, INITIAL, true, H), f.workflow, "Unauthorized");
  });
  it("rejects superseded versions and duplicate outcomes", async function () {
    const f = await fixture(); await submit(f); await submit(f, f.bidder, 2); await close(f); await open(f, INITIAL);
    await fails(() => f.workflow.connect(f.service).recordOpeningResult(1, f.bidder.address, 1, INITIAL, true, H), f.workflow, "InvalidBid");
    await result(f, INITIAL, true, f.bidder, 2);
    await fails(() => f.workflow.connect(f.service).recordOpeningResult(1, f.bidder.address, 2, INITIAL, true, H), f.workflow, "InvalidBid");
  });
  it("rejects withdrawn bids while retaining their evidence", async function () {
    const f = await fixture(); await submit(f); await submit(f, f.bidder2); await tx(f.workflow.connect(f.bidder).withdrawBid(1));
    await close(f); await open(f, INITIAL);
    await fails(() => f.workflow.connect(f.service).recordOpeningResult(1, f.bidder.address, 1, INITIAL, true, H), f.workflow, "InvalidBid");
    assert.equal((await f.workflow.getTender(1)).pendingOpenings, 1n);
  });
  it("requires a human decision on failed initial verification and blocks admission", async function () {
    const f = await fixture(); await submit(f); await close(f); await open(f, INITIAL); await result(f, INITIAL, false);
    assert.equal((await f.workflow.getBid(1, f.bidder.address)).admissionRecorded, false);
    await fails(() => f.workflow.connect(f.commission).recordAdmission(1, f.bidder.address, true, H), f.workflow, "InvalidBid");
    await tx(f.workflow.connect(f.commission).recordAdmission(1, f.bidder.address, false, H));
    assert.equal((await f.workflow.getTender(1)).financialEligibleBids, 0n);
  });
  it("does not open financial parts while initial reviews are incomplete", async function () {
    const f = await fixture(); await submit(f); await submit(f, f.bidder2); await close(f); await open(f, INITIAL); await result(f, INITIAL);
    await tx(f.workflow.connect(f.commission).recordAdmission(1, f.bidder.address, true, H));
    await fails(() => f.workflow.connect(f.commission).requestOpening(1, FINANCIAL), f.workflow, "IncompleteReview");
  });
  it("completes a tender without a separate technical offer", async function () {
    const f = await fixture(); await select(f); assert.equal((await f.workflow.getTender(1)).state, 5n);
    await tx(f.workflow.connect(f.commission).recordPublicExtract(1, H));
    await tx(f.workflow.connect(f.approver).decideFinalApproval(1, true, H)); assert.equal((await f.workflow.getTender(1)).state, 6n);
  });
  it("completes a tender with a separate technical offer", async function () {
    const f = await fixture(true); await select(f); assert.equal((await f.workflow.getTender(1)).state, 5n);
    assert.equal((await f.workflow.getBid(1, f.bidder.address)).technicalAccepted, true);
  });
  it("does not skip the configured technical stage", async function () {
    const f = await fixture(true); await initial(f);
    await fails(() => f.workflow.connect(f.commission).requestOpening(1, FINANCIAL), f.workflow, "IncompleteReview");
  });
  it("excludes a failed technical offer from financial eligibility", async function () {
    const f = await fixture(true); await initial(f); await open(f, TECHNICAL); await result(f, TECHNICAL, false);
    await fails(() => f.workflow.connect(f.commission).recordTechnicalDecision(1, f.bidder.address, true, H), f.workflow, "InvalidBid");
    await tx(f.workflow.connect(f.commission).recordTechnicalDecision(1, f.bidder.address, false, H));
    await fails(() => f.workflow.connect(f.commission).requestOpening(1, FINANCIAL), f.workflow, "IncompleteReview");
  });
  it("separates commission selection from final government approval", async function () {
    const f = await fixture(); await select(f); await tx(f.registry.grantRole(await f.registry.APPROVAL_ROLE(), f.commission.address));
    await fails(() => f.workflow.connect(f.commission).decideFinalApproval(1, true, H), f.workflow, "Unauthorized");
    await tx(f.workflow.connect(f.approver).decideFinalApproval(1, false, H)); assert.equal((await f.workflow.getTender(1)).state, 9n);
  });
  it("restricts pausing to government and preserves emergency cancellation", async function () {
    const f = await fixture(); await fails(() => f.workflow.connect(f.bidder).setPaused(true), f.workflow, "Unauthorized");
    await tx(f.workflow.setPaused(true));
    await fails(() => f.workflow.connect(f.bidder).submitBid(1, 1, E, EMPTY, E), f.workflow, "PlatformPaused");
    await tx(f.workflow.cancelTender(1, H)); assert.equal((await f.workflow.getTender(1)).state, 7n);
    await fails(() => f.workflow.cancelTender(1, H), f.workflow, "WrongState");
  });
  it("records an empty closed tender as unsuccessful", async function () {
    const f = await fixture(); await close(f); await tx(f.workflow.connect(f.commission).declareUnsuccessful(1, H));
    assert.equal((await f.workflow.getTender(1)).state, 8n);
  });
});
