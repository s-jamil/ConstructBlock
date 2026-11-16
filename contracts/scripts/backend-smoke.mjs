import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import hre from "hardhat";
import { createApp } from "../../backend/dist/app.js";
import { BlockchainService } from "../../backend/dist/blockchain.js";
import { inject } from "../../backend/test/inject.mjs";
const connection = await hre.network.create();
const { ethers } = connection;
const [government, officer, commission, bidder, outsider] = await ethers.getSigners();
const registry = await ethers.deployContract("RoleRegistry", [government.address, 86400]);
await registry.waitForDeployment();
for (const [role, actor] of [[await registry.OFFICER_ROLE(), officer], [await registry.COMMISSION_ROLE(), commission]])
  await (await registry.grantRole(role, actor.address)).wait();
await (await registry.approveBidder(bidder.address)).wait();
const workflow = await ethers.deployContract("ProcurementWorkflow", [await registry.getAddress()]);
await workflow.waitForDeployment();
const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
await (await workflow.connect(officer).publishTender(ethers.id("public dossier"), deadline, false,
  commission.address, [ethers.id("initial key"), ethers.ZeroHash, ethers.id("financial key")])).wait();
// Adapt Hardhat's in-process EIP-1193 provider: real EVM calls, no network socket.
const provider = new ethers.BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
const config = { port: 3001, rpcUrl: "http://127.0.0.1:8545", chainId: 31337n,
  rpcTimeoutMs: 2000, registryAddress: await registry.getAddress(), workflowAddress: await workflow.getAddress() };
const service = new BlockchainService(config, provider);
const app = createApp(service);
const checks = [];
async function request(url, expected = 200, handler = app) {
  const response = await inject((req, res) => handler(req, res), { method: "GET", url });
  assert.equal(response.statusCode, expected, `${url}: ${response.payload}`);
  return JSON.parse(response.payload);
}
async function check(label, fn) { await fn(); checks.push(label); console.log(`PASS  ${label}`); }
try {
  await check("Health endpoint is available", async () => assert.equal((await request("/health")).status, "ok"));
  await check("Status checks real EVM deployment and linked registry", async () => {
    const value = await request("/api/blockchain/status");
    assert.equal(value.chainId, "31337"); assert.equal(value.contracts.registryLinked, true);
  });
  await check("Legacy or incompatible opening policies fail readiness", async () => {
    for(const result of ['0x', ethers.AbiCoder.defaultAbiCoder().encode(['uint8'],[1])]){
      const wrapped=new Proxy(provider,{get(target,key){
        if(key==='call')return async transaction=>transaction.data===workflow.interface.encodeFunctionData('OPENING_POLICY_VERSION')?result:target.call(transaction);
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
      const incompatible=createApp(new BlockchainService(config,wrapped));
      assert.equal((await request('/api/blockchain/status',503,incompatible)).error.code,'OPENING_POLICY_MISMATCH');
    }
  });
  await check("Tender endpoint decodes real Solidity tuple and filters restricted fields", async () => {
    const value = await request("/api/tenders/1");
    assert.equal(value.state, "Open"); assert.equal(value.deadlineTimestamp, String(deadline));
    assert.equal(value.publicExtractDigest, null);
    for (const field of ["commission", "officer", "selectedBidder", "selectionDigest", "admissionDecisions", "pendingOpenings", "financialEligibleBids"])
      assert.equal(field in value, false, `Restricted field exposed: ${field}`);
  });
  await check("Unknown tender maps to 404", async () => assert.equal((await request("/api/tenders/999", 404)).error.code, "TENDER_NOT_FOUND"));
  await check("Approved and unapproved wallets reflect real registry roles", async () => {
    assert.equal((await request(`/api/bidders/${bidder.address}/status`)).approved, true);
    assert.equal((await request(`/api/bidders/${outsider.address}/status`)).approved, false);
  });
  await check("Role revocation is visible on the next read", async () => {
    await (await registry.revokeBidder(bidder.address)).wait();
    assert.equal((await request(`/api/bidders/${bidder.address}/status`)).approved, false);
  });
  await check("Wrong expected chain is rejected", async () => {
    const wrong = createApp(new BlockchainService({ ...config, chainId: 1n }, provider));
    assert.equal((await request("/api/blockchain/status", 503, wrong)).error.code, "CHAIN_MISMATCH");
  });
  await check("An address without deployed code is rejected", async () => {
    const missing = createApp(new BlockchainService({ ...config, workflowAddress: outsider.address }, provider));
    assert.equal((await request("/api/blockchain/status", 503, missing)).error.code, "CONTRACT_NOT_DEPLOYED");
  });
  await check("A registry from a different deployment is rejected", async () => {
    const otherRegistry = await ethers.deployContract("RoleRegistry", [government.address, 86400]); await otherRegistry.waitForDeployment();
    const wrong = createApp(new BlockchainService({ ...config, registryAddress: await otherRegistry.getAddress() }, provider));
    assert.equal((await request("/api/blockchain/status", 503, wrong)).error.code, "CONTRACT_MISMATCH");
  });
  await check("RPC failures are sanitized and health stays available", async () => {
    const failed = createApp(new BlockchainService(config, { getNetwork: async () => { throw new Error("RPC URL with secret credentials"); } }));
    const result = await request("/api/blockchain/status", 503, failed);
    assert.equal(result.error.code, "BLOCKCHAIN_UNAVAILABLE"); assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal((await request("/health", 200, failed)).status, "ok");
  });
  await check("An unresponsive provider is bounded by the configured timeout", async () => {
    const stuck = createApp(new BlockchainService({ ...config, rpcTimeoutMs: 100 }, { getNetwork: async () => new Promise(() => {}) }));
    assert.equal((await request("/api/blockchain/status", 503, stuck)).error.code, "RPC_TIMEOUT");
  });
  const directory = new URL("../../backend/reports/", import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL("milestone-1-smoke.json", directory), JSON.stringify({ project: "constructBlock",
    generatedAt: new Date().toISOString(), result: "passed", checks,
    execution: "Real isolated Hardhat EVM; HTTP handler injection without a listening TCP socket",
    chainId: "31337", contracts: { registry: config.registryAddress, workflow: config.workflowAddress },
    limitations: ["Does not test an OS TCP listener or the user's existing localhost node", "No authentication, transaction signing or production deployment"] }, null, 2) + "\n");
  console.log(`\n${checks.length} backend/EVM integration checks passed.`);
} finally { provider.destroy(); await connection.close(); }
