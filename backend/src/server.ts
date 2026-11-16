import {configuredCiphertextStore} from './orbitdb-client.ts';
import { EncryptedStorage } from "./storage.ts";
import { createApp } from "./app.ts";
import { BlockchainService } from "./blockchain.ts";
import { loadConfig } from "./config.ts";
try {
  const config = loadConfig();
  const blockchain = new BlockchainService(config);
  const server = createApp(blockchain, new EncryptedStorage(blockchain, process.env.STORAGE_DIR, process.env.OPENING_KEYS_DIR, undefined, configuredCiphertextStore())).listen(config.port, "127.0.0.1", () => {
    console.log(`constructBlock API and encrypted storage: http://127.0.0.1:${config.port}`);
    console.log("Check /api/blockchain/status for deployment readiness; /health only checks this process.");
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(`Cannot start API listener (${error.code ?? "unknown error"}).`);
    blockchain.provider.destroy(); process.exitCode = 1;
  });
  function shutdown() { server.close(() => { blockchain.provider.destroy(); }); }
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid backend configuration.");
  process.exitCode = 1;
}
