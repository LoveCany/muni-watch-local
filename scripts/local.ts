import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" };
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const children = [
  spawn(process.execPath, [path.join(root, "node_modules", "vinext", "dist", "cli.js"), "dev", "--host", "127.0.0.1", "--port", "3002"], { cwd: root, env, stdio: "inherit" }),
  spawn(process.execPath, [tsxCli, path.join(root, "collector", "server.ts")], { cwd: root, env, stdio: "inherit" }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 250);
}

for (const child of children) child.on("exit", (code, signal) => { if (!stopping && (code || signal)) stop(code ?? 1); });
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
