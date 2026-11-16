import { readFile, writeFile } from "node:fs/promises";
import { getAddress } from "ethers";
const manifest = new URL("../../contracts/deployments/localhost.json", import.meta.url);
let deployment;
try { deployment = JSON.parse(await readFile(manifest, "utf8")); }
catch { throw new Error("No deployment manifest found. Run npm run deploy:local in contracts first, then rerun npm run configure:local."); }
if (deployment.chainId !== 31337) throw new Error("Expected a local Hardhat deployment on chain 31337");
const registry = getAddress(deployment.contracts.RoleRegistry);
const workflow = getAddress(deployment.contracts.ProcurementWorkflow);
const envFile = new URL("../.env", import.meta.url);
let content = "";
try { content = await readFile(envFile, "utf8"); } catch { content = await readFile(new URL("../.env.example", import.meta.url), "utf8"); }
for (const [key, value] of Object.entries({ CHAIN_ID: "31337", ROLE_REGISTRY_ADDRESS: registry, PROCUREMENT_WORKFLOW_ADDRESS: workflow })) {
  const line = new RegExp(`^${key}=.*$`, "m");
  content = line.test(content) ? content.replace(line, `${key}=${value}`) : `${content.trimEnd()}\n${key}=${value}\n`;
}
await writeFile(envFile, content);
console.log("Updated backend/.env contract addresses from the local deployment manifest. Restart the backend to load them.");
