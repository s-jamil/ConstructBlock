import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const frontend = new URL("frontend/", root);
const backend = new URL("backend/", root);
const vite = new URL("node_modules/vite/bin/vite.js", frontend);
if (!existsSync(vite) || !existsSync(new URL("node_modules/express/package.json", backend))) {
  console.error("Install frontend/backend dependencies first: npm run install:apps");
  process.exit(1);
}
console.log("constructBlock: starting the API and frontend. Keep your Hardhat node running separately.");
const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  for (const child of children) if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
}
for (const [name, cwd, args] of [
  ["API", backend, ["--env-file-if-exists=.env", "--watch", "src/server.ts"]],
  ["frontend", frontend, [fileURLToPath(vite)]],
]) {
  const child = spawn(process.execPath, args, { cwd: fileURLToPath(cwd), stdio: "inherit", env: process.env });
  children.push(child);
  child.on("error", () => { console.error(`Cannot launch ${name}.`); stop(1); });
  child.on("exit", (code, signal) => {
    if (!stopping) { console.error(`${name} stopped (${signal ?? code ?? "unknown"}); stopping the other app.`); stop(code ?? 1); }
  });
}
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
