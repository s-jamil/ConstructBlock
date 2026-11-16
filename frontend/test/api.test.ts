import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiError, getHealth, getChainStatus, getTender, getBidderStatus,
  validateTenderId, validateWalletAddress,
} from "../src/api.ts";

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const WORKFLOW = "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6";
const HASH = `0x${"ab".repeat(32)}`;
const health = { status: "ok", service: "constructBlock-backend", mode: "read-only" };
const chain = { ready: true, chainId: "31337", expectedChainId: "31337", blockNumber: 99,
  contracts: { roleRegistry: REGISTRY, procurementWorkflow: WORKFLOW, registryLinked: true } };
const tender = { id: "1", state: "Open", stateCode: 0, deadlineTimestamp: "1900000000",
  deadlineIso: "2030-03-17T17:46:40.000Z", requiresTechnicalOffer: false,
  dossierDigest: HASH, publicExtractDigest: null, blockNumber: 99 };

async function withFetch<T>(mock: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); } finally { globalThis.fetch = original; }
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function apiError(code: string, status?: number) {
  return (error: unknown) => error instanceof ApiError && error.code === code
    && (status === undefined || error.status === status);
}
async function returning(value: unknown, run: () => Promise<unknown>, status = 200) {
  await withFetch(async () => response(value, status), run);
}

test("health and blockchain readiness use separate endpoints", async () => {
  const paths: string[] = [];
  await withFetch(async (path) => {
    paths.push(String(path));
    if (path === "/health") return response(health);
    return response({ error: { code: "BLOCKCHAIN_UNAVAILABLE", message: "Node is offline" } }, 503);
  }, async () => {
    assert.deepEqual(await getHealth(), health);
    await assert.rejects(getChainStatus(), apiError("BLOCKCHAIN_UNAVAILABLE", 503));
  });
  assert.deepEqual(paths, ["/health", "/api/blockchain/status"]);
});

test("read requests do not cache data or send write methods", async () => {
  await withFetch(async (path, options) => {
    assert.equal(path, "/api/blockchain/status");
    assert.equal(options?.method, "GET");
    assert.equal(options?.cache, "no-store");
    assert.equal((options?.headers as Record<string, string>).Accept, "application/json");
    return response(chain);
  }, async () => assert.deepEqual(await getChainStatus(), chain));
});

test("large tender IDs remain exact decimal strings", async () => {
  const id = "9007199254740993";
  await withFetch(async path => {
    assert.equal(path, `/api/tenders/${id}`);
    return response({ ...tender, id });
  }, async () => assert.equal((await getTender(id)).id, id));
});

test("uint256 limit is accepted without Number conversion", () => {
  assert.equal(validateTenderId((2n ** 256n - 1n).toString()), null);
  assert.notEqual(validateTenderId((2n ** 256n).toString()), null);
});

for (const value of ["", "0", "-1", "1.5", "1e3", "01", " 1", "9".repeat(79), (2n ** 256n).toString()]) {
  test(`invalid tender IDs never trigger fetch: ${JSON.stringify(value.slice(0, 12))}`, async () => {
    let calls = 0;
    await withFetch(async () => { calls++; return response(tender); }, async () => {
      assert.notEqual(validateTenderId(value), null);
      await assert.rejects(getTender(value), apiError("INVALID_TENDER_ID", 400));
    });
    assert.equal(calls, 0);
  });
}

test("tender 404 is retained as a missing tender, not disconnected backend", async () => {
  await returning({ error: { code: "TENDER_NOT_FOUND", message: "No tender exists with this ID." } }, async () => {
    await assert.rejects(getTender("1"), apiError("TENDER_NOT_FOUND", 404));
  }, 404);
});

test("false bidder approval is a successful read, not an error", async () => {
  const result = { address: WALLET, approved: false, blockNumber: 99 };
  await returning(result, async () => assert.deepEqual(await getBidderStatus(WALLET.toLowerCase()), result));
});

test("an approval service failure is not converted into approved false", async () => {
  await returning({ error: { code: "RPC_TIMEOUT", message: "Blockchain timed out" } }, async () => {
    await assert.rejects(getBidderStatus(WALLET), apiError("RPC_TIMEOUT", 503));
  }, 503);
});

test("wallet checksum and zero-address validation run before a request", async () => {
  const values = ["bad", "0x0000000000000000000000000000000000000000",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C9"];
  let calls = 0;
  await withFetch(async () => { calls++; return response({}); }, async () => {
    for (const value of values) {
      assert.notEqual(validateWalletAddress(value), null);
      await assert.rejects(getBidderStatus(value), apiError("INVALID_ADDRESS", 400));
    }
  });
  assert.equal(calls, 0);
});

test("an unavailable backend produces a network error", async () => {
  await withFetch(async () => { throw new TypeError("Failed to fetch"); }, async () => {
    await assert.rejects(getHealth(), apiError("NETWORK_UNAVAILABLE"));
  });
});

test("HTML proxy errors are handled as invalid responses", async () => {
  await withFetch(async () => new Response("<h1>Bad gateway</h1>", { status: 502 }), async () => {
    await assert.rejects(getChainStatus(), apiError("INVALID_RESPONSE", 502));
  });
});

test("an explicit request cancellation is preserved as AbortError", async () => {
  const controller = new AbortController(); controller.abort();
  await withFetch(async (_url, options) => {
    assert.equal(options?.signal?.aborted, true);
    throw new DOMException("The request was aborted", "AbortError");
  }, async () => assert.rejects(getHealth(controller.signal), error => error instanceof DOMException && error.name === "AbortError"));
});

for (const value of [null, {}, { ...chain, ready: false }, { ...chain, chainId: "1" },
  { ...chain, blockNumber: Number.MAX_SAFE_INTEGER + 1 }, { ...chain, contracts: { ...chain.contracts, registryLinked: false } }]) {
  test(`malformed readiness cannot be displayed as connected: ${JSON.stringify(value)?.slice(0, 45)}`, async () => {
    await returning(value, async () => assert.rejects(getChainStatus(), apiError("INVALID_RESPONSE")));
  });
}

test("unexpected successful health payload is rejected", async () => {
  await returning({ status: "ok", service: "other", mode: "writable" }, async () => assert.rejects(getHealth(), apiError("INVALID_RESPONSE")));
});

for (const value of [{ ...tender, stateCode: "0" }, { ...tender, stateCode: 1.5 },
  { ...tender, stateCode: 10 }, { ...tender, state: "Approved" },
  { ...tender, state: undefined, stateCode: undefined }, { ...tender, id: "2" },
  { ...tender, dossierDigest: "not-a-hash" }, { ...tender, requiresTechnicalOffer: "false" }]) {
  test(`invalid tender payload is rejected: ${JSON.stringify(value).slice(0, 60)}`, async () => {
    await returning(value, async () => assert.rejects(getTender("1"), apiError("INVALID_RESPONSE")));
  });
}

test("a supported null ISO deadline is retained without an invalid date", async () => {
  const result = { ...tender, deadlineIso: null, deadlineTimestamp: "18446744073709551615" };
  await returning(result, async () => assert.deepEqual(await getTender("1"), result));
});

for (const value of [{ address: WALLET, approved: "false", blockNumber: 1 },
  { address: REGISTRY, approved: true, blockNumber: 1 }, { address: WALLET, approved: false, blockNumber: -1 }]) {
  test("bidder results must match the requested wallet and boolean approval", async () => {
    await returning(value, async () => assert.rejects(getBidderStatus(WALLET), apiError("INVALID_RESPONSE")));
  });
}

test("health accepts the configured encrypted storage service", async () => {
  await returning({ ...health, mode: "encrypted-storage" }, async () => assert.equal((await getHealth()).mode, "encrypted-storage"));
});
