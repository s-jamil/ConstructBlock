import { readFile, mkdir, writeFile } from "node:fs/promises";
const names = ["RoleRegistry", "ProcurementWorkflow"];
for (const name of names) {
  const source = new URL(`../../contracts/artifacts/contracts/${name}.sol/${name}.json`, import.meta.url);
  let artifact;
  try { artifact = JSON.parse(await readFile(source, "utf8")); }
  catch { throw new Error(`Cannot read ${name} artifact. Run npm run build in the contracts folder first.`); }
  if (artifact.contractName !== name || !Array.isArray(artifact.abi)) throw new Error(`Invalid ${name} artifact`);
  const target = new URL(`../src/abi/${name}.json`, import.meta.url);
  await mkdir(new URL("../src/abi/", import.meta.url), { recursive: true });
  await writeFile(target, JSON.stringify({ contractName: name, abi: artifact.abi }, null, 2) + "\n");
  console.log(`Synced ${name} ABI`);
}
