import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync,
  publicEncrypt, privateDecrypt, randomBytes, constants } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import hre from "hardhat";

// Synthetic, single-process demonstration. Custody isolation and browser encryption
// are subsequent components; no key or plaintext is written to the report.
const connection = await hre.network.create();
const { ethers } = connection;
assert.equal((await ethers.provider.getNetwork()).chainId, 31337n,
  "Walkthrough is restricted to local Hardhat chain 31337.");
const [government, officer, commission, , , service, approver, bidder] = await ethers.getSigners();
const transactions: { action: string; hash: string; block: number }[] = [];
async function confirmed(action: string, promise: Promise<any>) {
  const response = await promise;
  const receipt = await response.wait();
  assert.equal(receipt.status, 1, action);
  transactions.push({ action, hash: receipt.hash, block: receipt.blockNumber });
  console.log(`PASS  ${action}`);
  return receipt;
}
function sha(bytes: Uint8Array) { return `0x${createHash("sha256").update(bytes).digest("hex")}`; }
function frame(...values: Uint8Array[]) {
  return Buffer.concat(values.flatMap(value => {
    const size = Buffer.alloc(4); size.writeUInt32BE(value.length);
    return [size, Buffer.from(value)];
  }));
}
const registry: any = await ethers.deployContract("RoleRegistry", [government.address, 86400]);
await registry.waitForDeployment();
const workflow: any = await ethers.deployContract("ProcurementWorkflow", [await registry.getAddress()]);
await workflow.waitForDeployment();
console.log("Deployed a fresh demonstration pair; existing deployments are unchanged.");
for (const [role, actor, label] of [
  [await registry.OFFICER_ROLE(), officer, "officer"],
  [await registry.COMMISSION_ROLE(), commission, "commission"],
  [await registry.OPENING_SERVICE_ROLE(), service, "opening service"],
  [await registry.APPROVAL_ROLE(), approver, "approval authority"],
] as const) await confirmed(`Government assigns ${label}`, registry.grantRole(role, actor.address));
await confirmed("Government approves synthetic bidder", registry.approveBidder(bidder.address));
const partNames = ["initial", "technical", "financial"];
const custody = partNames.map(() => generateKeyPairSync("rsa", { modulusLength: 3072 }));
const fingerprints = custody.map(key => sha(key.publicKey.export({ type: "spki", format: "der" })));
const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
const dossierDigest = sha(Buffer.from(JSON.stringify({
  title: "Fictional school renovation tender", currency: "MAD", technicalOffer: true,
  criteria: ["Administrative admission", "Human technical assessment", "Human financial assessment"],
})));
const published = await confirmed("Officer publishes tender with three part keys",
  workflow.connect(officer).publishTender(dossierDigest, deadline, true, commission.address, fingerprints));
const event = published.logs.map((log: any) => {
  try { return workflow.interface.parseLog(log); } catch { return null; }
}).find((log: any) => log?.name === "TenderPublished");
assert.ok(event, "TenderPublished event missing");
const tenderId: bigint = event.args.tenderId;
const version = 1;
const payloads = [
  { organization: "Fictional Builder A", registration: "SYNTHETIC-001", eligible: true },
  { method: "Synthetic renovation plan", durationDays: 90 },
  { amountMAD: 750000, currency: "MAD", synthetic: true },
];
const packages = payloads.map((payload, part) => {
  const plaintext = Buffer.from(JSON.stringify(payload));
  const context = Buffer.from(JSON.stringify(["constructBlock-demo-v1", tenderId.toString(), bidder.address.toLowerCase(), part, version]));
  const key = randomBytes(32), salt = randomBytes(32), nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(context);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = publicEncrypt({ key: custody[part].publicKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.concat([key, salt]));
  const evidence = {
    commitment: sha(frame(context, salt, plaintext)),
    ciphertextHash: sha(frame(context, nonce, ciphertext, tag)),
    wrappedPackageHash: sha(wrapped),
  };
  return { context, nonce, ciphertext, tag, wrapped, evidence };
});
await confirmed("Bidder submits encrypted-part commitments and hashes",
  workflow.connect(bidder).submitBid(tenderId, version, ...packages.map(pkg => pkg.evidence)));
assert.equal((await workflow.getBid(tenderId, bidder.address)).version, 1n);
// Time travel is confined to a disposable chain by default. The --network localhost
// variant explicitly changes the clock of that shared development node.
await ethers.provider.send("evm_setNextBlockTimestamp", [deadline]);
await confirmed("Commission closes submissions at deadline", workflow.connect(commission).closeTender(tenderId));

async function openAndVerify(part: number) {
  const name = partNames[part];
  await confirmed(`Commission requests ${name} opening`, workflow.connect(commission).requestOpening(tenderId, part));
  const authorization = await workflow.getOpening(tenderId, part);
  assert.equal(authorization.requested, true);
  assert.equal(authorization.authorized, true);
  const stored = await workflow.getEvidence(tenderId, bidder.address, version, part);
  const pkg = packages[part];
  assert.equal(sha(frame(pkg.context, pkg.nonce, pkg.ciphertext, pkg.tag)), stored.ciphertextHash);
  assert.equal(sha(pkg.wrapped), stored.wrappedPackageHash);
  const openingMaterial = privateDecrypt({ key: custody[part].privateKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, pkg.wrapped);
  assert.equal(openingMaterial.length, 64);
  const decipher = createDecipheriv("aes-256-gcm", openingMaterial.subarray(0, 32), pkg.nonce);
  decipher.setAAD(pkg.context); decipher.setAuthTag(pkg.tag);
  const plaintext = Buffer.concat([decipher.update(pkg.ciphertext), decipher.final()]);
  assert.equal(sha(frame(pkg.context, openingMaterial.subarray(32), plaintext)), stored.commitment);
  assert.deepEqual(JSON.parse(plaintext.toString()), payloads[part]);
  // A modified encrypted file must not match the ledger's recorded fingerprint.
  const modified = Buffer.from(pkg.ciphertext); modified[0] ^= 1;
  assert.notEqual(sha(frame(pkg.context, pkg.nonce, modified, pkg.tag)), stored.ciphertextHash);
  await confirmed(`Service records verified ${name} outcome`, workflow.connect(service).recordOpeningResult(
    tenderId, bidder.address, version, part, true,
    sha(Buffer.from(JSON.stringify({ part, version, outcome: "verified", evidence: pkg.evidence })))));
  assert.equal(await workflow.getOutcome(tenderId, bidder.address, part), 1n);
}
await openAndVerify(0);
await confirmed("Commission admits verified bidder", workflow.connect(commission).recordAdmission(
  tenderId, bidder.address, true, sha(Buffer.from("Synthetic initial review accepted"))));
await openAndVerify(1);
await confirmed("Commission accepts technical offer", workflow.connect(commission).recordTechnicalDecision(
  tenderId, bidder.address, true, sha(Buffer.from("Synthetic technical review accepted"))));
await openAndVerify(2);
await confirmed("Commission records selection", workflow.connect(commission).selectBidder(
  tenderId, bidder.address, sha(Buffer.from("Synthetic selection against published criteria"))));
assert.equal((await workflow.getTender(tenderId)).state, 5n,
  "Selection must not be final approval");
const extractDigest = sha(Buffer.from(JSON.stringify({ tenderId: tenderId.toString(),
  selected: "Fictional Builder A", notice: "Synthetic public extract" })));
await confirmed("Commission records approved public extract digest",
  workflow.connect(commission).recordPublicExtract(tenderId, extractDigest));
await confirmed("Separate authority records final approval", workflow.connect(approver).decideFinalApproval(
  tenderId, true, sha(Buffer.from("Synthetic final approval"))));
const final = await workflow.getTender(tenderId);
assert.equal(final.state, 6n); assert.equal(final.selectedBidder, bidder.address);
assert.equal(final.publicExtractDigest, extractDigest);
assert.equal(final.pendingOpenings, 0n); assert.equal(final.financialEligibleBids, 1n);
const report = {
  project: "constructBlock", generatedAt: new Date().toISOString(), network: connection.networkName,
  chainId: 31337, tenderId: tenderId.toString(), finalState: "Approved",
  contracts: { RoleRegistry: await registry.getAddress(), ProcurementWorkflow: await workflow.getAddress() },
  selectedBidder: bidder.address,
  checks: { commissionAuthorizationPerPart: true, sha256EvidenceMatched: true, authenticatedDecryption: true,
    saltedCommitmentsMatched: true, alteredCiphertextDetected: true, selectionSeparateFromApproval: true },
  limitations: ["Synthetic single-bidder run, not a procurement outcome study",
    "Custody, client and service simulated in one process; no production isolation",
    "Public extract recorded as a digest, not actually published to a website",
    "Default chain is ephemeral; local node history persists only while that node retains state"],
  transactions,
};
await mkdir("reports", { recursive: true });
const reportFile = `reports/walkthrough-${Date.now()}.json`;
await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
console.log(`\nSUCCESS: tender ${tenderId} reached Approved. ${transactions.length} confirmed actions.`);
console.log(`Evidence report: ${reportFile} (no keys, salts, wrapped packages or bid contents).`);
