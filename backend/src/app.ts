import express, { type ErrorRequestHandler } from "express";
import { getAddress, ZeroAddress } from "ethers";
import { ApiError } from "./errors.ts";
import type { BlockchainReader } from "./blockchain.ts";
import type { EncryptedStorage } from "./storage.ts";
export function createApp(blockchain: BlockchainReader, storage?: EncryptedStorage) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "constructBlock-backend", mode: storage ? "encrypted-storage" : "read-only" });
  });
  app.get("/api/blockchain/status", async (_req, res) => { res.json(await blockchain.status()); });
  app.get("/api/tenders/:id", async (req, res) => {
    const value = req.params.id;
    if (!/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) >= 2n ** 256n)
      throw new ApiError(400, "INVALID_TENDER_ID", "Tender ID must be a positive uint256 decimal integer.");
    res.json(await blockchain.tender(BigInt(value)));
  });
  app.get("/api/bidders/:address/status", async (req, res) => {
    let address: string;
    try { address = getAddress(req.params.address); if (address === ZeroAddress) throw new Error(); }
    catch { throw new ApiError(400, "INVALID_ADDRESS", "Supply a nonzero Ethereum wallet address with a valid checksum or lowercase spelling."); }
    res.json(await blockchain.bidderStatus(address));
  });
  if (storage) {
    const rates = new Map<string, { count: number; until: number }>();
    app.use("/api/storage", (req, _res, next) => {
      const now = Date.now();
      for (const [key, value] of rates) if (value.until < now) rates.delete(key);
      const key = req.socket.remoteAddress ?? "local";
      const value = rates.get(key) ?? { count: 0, until: now + 60000 };
      rates.set(key, value); value.count++;
      if (value.count > 30 || rates.size > 1000) return next(new ApiError(429, "RATE_LIMITED", "Too many storage requests. Wait one minute."));
      if (req.method === "POST" && !req.is("application/json")) return next(new ApiError(415, "JSON_REQUIRED", "Send an application/json encrypted package."));
      next();
    }, express.json({ limit: "8mb", strict: true }));
    app.get("/api/opening-keys/:fingerprint", async (req, res) => { res.json(await storage.publicKey(req.params.fingerprint)); });
    app.post("/api/storage/bids", async (req, res) => {
      res.status(201).json(await storage.upload(req.body, req.get("X-Storage-Timestamp") ?? "", req.get("X-Storage-Signature") ?? ""));
    });
    app.post("/api/storage/openings/retrieve", async (req, res) => {
      res.json(await storage.retrieveOpening(req.body, req.get("X-Opening-Signature") ?? ""));
    });
    app.post("/api/storage/:contentId/retrieve", async (req, res) => {
      res.json(await storage.retrieve(req.params.contentId, req.body, req.get("X-Storage-Timestamp") ?? "", req.get("X-Storage-Signature") ?? ""));
    });
  }
  app.use((req, _res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) return next(new ApiError(405, "METHOD_NOT_ALLOWED", storage ? "Use a declared public-read or signed storage endpoint." : "This milestone supports read-only requests."));
    next(new ApiError(404, "ROUTE_NOT_FOUND", "No endpoint exists at this path."));
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const bodyError = error as { type?: string };
    const known = error instanceof ApiError ? error : bodyError?.type === "entity.too.large"
      ? new ApiError(413, "PACKAGE_TOO_LARGE", "Encrypted package exceeds the request limit.")
      : bodyError?.type === "entity.parse.failed" ? new ApiError(400, "INVALID_JSON", "The request body is not valid JSON.")
      : new ApiError(500, "INTERNAL_ERROR", "An unexpected server error occurred.");
    if (known.status === 405) res.set("Allow", storage ? "GET, HEAD, POST" : "GET, HEAD");
    res.status(known.status).json({ error: { code: known.code, message: known.message, ...(known.details ? { details: known.details } : {}) } });
  };
  app.use(errors);
  return app;
}
