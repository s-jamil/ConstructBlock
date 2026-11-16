import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import hre from "hardhat";
const { ethers } = await hre.network.create();
assert.equal((await ethers.provider.getNetwork()).chainId, 31337n,
  "This demonstration deployment requires local chain 31337.");
const [government, officer, commission, , , service, approver, bidder] = await ethers.getSigners();
const registry: any = await ethers.deployContract("RoleRegistry", [government.address, 86400]);
await registry.waitForDeployment();
for (const [role, actor] of [
  [await registry.OFFICER_ROLE(), officer], [await registry.COMMISSION_ROLE(), commission],
  [await registry.OPENING_SERVICE_ROLE(), service], [await registry.APPROVAL_ROLE(), approver],
] as const) await (await registry.grantRole(role, actor.address)).wait();
await (await registry.approveBidder(bidder.address)).wait();
const workflow: any = await ethers.deployContract("ProcurementWorkflow", [await registry.getAddress()]);
await workflow.waitForDeployment();
const deployment = { chainId: 31337, openingPolicyVersion: 2,
  contracts: { RoleRegistry: await registry.getAddress(), ProcurementWorkflow: await workflow.getAddress() },
  accounts: { government: government.address, officer: officer.address, commission: commission.address,
    openingService: service.address,
    approver: approver.address, bidder: bidder.address },
};
await mkdir("deployments", { recursive: true });
await writeFile("deployments/localhost.json", JSON.stringify(deployment, null, 2) + "\n");
console.log(JSON.stringify(deployment, null, 2));
console.log("Saved deployments/localhost.json; run npm run configure:local in backend to import these addresses.");
