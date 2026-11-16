import { getAddress, ZeroAddress } from "ethers";
export interface Config {
  port: number;
  rpcUrl: string;
  chainId: bigint;
  rpcTimeoutMs: number;
  registryAddress: string;
  workflowAddress: string;
}
function integer(value: string, name: string, min: number, max: number) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} is outside the allowed range`);
  return parsed;
}
function address(value: string | undefined, name: string) {
  if (!value) throw new Error(`Set ${name} in backend/.env using your deploy:local output`);
  try { const parsed = getAddress(value); if (parsed === ZeroAddress) throw new Error(); return parsed; }
  catch { throw new Error(`${name} must be a nonzero Ethereum address`); }
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = env.RPC_URL ?? "http://127.0.0.1:8545";
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("RPC_URL must be an HTTP or HTTPS URL"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.hash) throw new Error("RPC_URL must be an HTTP or HTTPS URL without a fragment");
  const chainId = env.CHAIN_ID ?? "31337";
  if (!/^[1-9][0-9]{0,77}$/.test(chainId) || BigInt(chainId) >= 2n ** 256n) throw new Error("CHAIN_ID must be a positive uint256 integer");
  const registryAddress = address(env.ROLE_REGISTRY_ADDRESS, "ROLE_REGISTRY_ADDRESS");
  const workflowAddress = address(env.PROCUREMENT_WORKFLOW_ADDRESS, "PROCUREMENT_WORKFLOW_ADDRESS");
  if (registryAddress === workflowAddress) throw new Error("Contract addresses must be different");
  return { port: integer(env.PORT ?? "3001", "PORT", 1, 65535), rpcUrl: url.toString(),
    chainId: BigInt(chainId), rpcTimeoutMs: integer(env.RPC_TIMEOUT_MS ?? "5000", "RPC_TIMEOUT_MS", 100, 30000),
    registryAddress, workflowAddress };
}
