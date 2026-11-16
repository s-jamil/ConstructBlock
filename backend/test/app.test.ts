import assert from "node:assert/strict";
import { test } from "node:test";
import { inject } from "./inject.mjs";
import { createApp } from "../src/app.ts";
import { ApiError } from "../src/errors.ts";
import { loadConfig } from "../src/config.ts";
import type { BlockchainReader } from "../src/blockchain.ts";
const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const reader: BlockchainReader = {
  async status() { return { ready: true, chainId: "31337", expectedChainId: "31337", blockNumber: 10,
    contracts: { roleRegistry: A, procurementWorkflow: A, registryLinked: true } }; },
  async tender(id) { return { id: id.toString(), state: "Open", stateCode: 0, deadlineTimestamp: "1900000000",
    deadlineIso: "2030-03-17T17:46:40.000Z", requiresTechnicalOffer: false, dossierDigest: "0x123", publicExtractDigest: null, blockNumber: 10 }; },
  async bidderStatus(address) { return { address, approved: true, blockNumber: 10 }; },
};
function request(url: string, custom: BlockchainReader = reader, method = "GET") {
  const app = createApp(custom);
  return inject((req, res) => app(req, res), { method, url });
}
test("health does not call the blockchain", async () => {
  const broken = { ...reader, status: async () => { throw new Error("offline"); } };
  const r = await request("/health", broken); assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.payload).mode, "read-only"); assert.equal(r.headers["x-powered-by"], undefined);
});
test("status reports connected deployment", async () => {
  const r = await request("/api/blockchain/status"); assert.equal(r.statusCode, 200); assert.equal(JSON.parse(r.payload).chainId, "31337");
});
test("returns explicit tender JSON and keeps a large ID as a string", async () => {
  const id = "9007199254740993"; const r = await request(`/api/tenders/${id}`);
  assert.equal(r.statusCode, 200); assert.equal(JSON.parse(r.payload).id, id);
});
for (const id of ["0", "-1", "1.5", "abc", "01", (2n ** 256n).toString(), "9".repeat(79)]) {
  test(`invalid tender ID is rejected before reading chain: ${id.slice(0, 12)}`, async () => {
    const r = await request(`/api/tenders/${id}`); assert.equal(r.statusCode, 400); assert.equal(JSON.parse(r.payload).error.code, "INVALID_TENDER_ID");
  });
}
test("missing tender maps to 404", async () => {
  const r = await request("/api/tenders/99", { ...reader, async tender() { throw new ApiError(404, "TENDER_NOT_FOUND", "Not found"); } });
  assert.equal(r.statusCode, 404);
});
test("wallet addresses are normalized to checksummed form", async () => {
  const r = await request(`/api/bidders/${A.toLowerCase()}/status`);
  assert.equal(r.statusCode, 200); assert.equal(JSON.parse(r.payload).address, A); assert.equal(JSON.parse(r.payload).approved, true);
});
for (const value of ["bad-wallet", "0x0000000000000000000000000000000000000000", "0x70997970C51812dc3A010C7d01b50e0d17dc79C9"]) {
  test(`invalid wallet returns 400: ${value.slice(0, 12)}`, async () => { assert.equal((await request(`/api/bidders/${value}/status`)).statusCode, 400); });
}
test("chain mismatch remains 503 with expected and actual IDs", async () => {
  const r = await request("/api/blockchain/status", { ...reader, async status() {
    throw new ApiError(503, "CHAIN_MISMATCH", "Wrong chain", { expectedChainId: "31337", actualChainId: "1" });
  } });
  assert.equal(r.statusCode, 503); assert.equal(JSON.parse(r.payload).error.details.actualChainId, "1");
});
test("unavailable RPC produces 503 while health remains available", async () => {
  const broken = { ...reader, async status() { throw new ApiError(503, "BLOCKCHAIN_UNAVAILABLE", "Offline"); } };
  assert.equal((await request("/api/blockchain/status", broken)).statusCode, 503);
  assert.equal((await request("/health", broken)).statusCode, 200);
});
test("unexpected errors do not expose secrets, RPC URLs or stacks", async () => {
  const r = await request("/api/blockchain/status", { ...reader, async status() { throw new Error("https://user:secret@rpc.example/private"); } });
  assert.equal(r.statusCode, 500); assert.equal(r.payload.includes("secret"), false); assert.equal(r.payload.includes("stack"), false);
});
test("write requests are rejected", async () => {
  const r = await request("/api/tenders/1", reader, "POST"); assert.equal(r.statusCode, 405); assert.equal(r.headers.allow, "GET, HEAD");
});
test("unknown routes return JSON 404 and responses are not cached", async () => {
  const r = await request("/unknown"); assert.equal(r.statusCode, 404); assert.equal(r.headers["cache-control"], "no-store");
});
const env = { ROLE_REGISTRY_ADDRESS: A, PROCUREMENT_WORKFLOW_ADDRESS: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" };
test("configuration validates contract addresses and safe defaults", () => {
  const config = loadConfig(env); assert.equal(config.chainId, 31337n); assert.equal(config.port, 3001);
  assert.throws(() => loadConfig({}), /ROLE_REGISTRY_ADDRESS/);
  assert.throws(() => loadConfig({ ...env, ROLE_REGISTRY_ADDRESS: "bad" }), /address/);
  assert.throws(() => loadConfig({ ...env, PROCUREMENT_WORKFLOW_ADDRESS: A }), /different/);
});
test("configuration rejects invalid ports, URLs, chain IDs and timeouts", () => {
  for (const override of [{ PORT: "0" }, { PORT: "3.14" }, { RPC_URL: "file:///etc/passwd" }, { CHAIN_ID: "-1" },
    { CHAIN_ID: (2n ** 256n).toString() }, { RPC_TIMEOUT_MS: "0" }]) assert.throws(() => loadConfig({ ...env, ...override }));
});
