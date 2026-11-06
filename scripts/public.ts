import { spawn } from "node:child_process";
import { existsSync, unwatchFile, watchFile } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceDiagnostics, recordProcessLifecycle } from "../collector/service-diagnostics.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lifecycle = createServiceDiagnostics(root, "public_launcher");
recordProcessLifecycle(lifecycle);
const bundledCloudflared = path.join(root, "tools", "cloudflared.exe");
const cloudflared = existsSync(bundledCloudflared) ? bundledCloudflared : "cloudflared";
const quickTunnelConfig = path.join(root, "tools", "quick-tunnel.yml");
const serverEntry = path.join(root, "dist", "server", "index.js");
const publicFrontendPort = "3003";
const reuseTunnel = process.env.MUNI_REUSE_TUNNEL === "1";
const existingTunnelPid = Number(process.env.MUNI_EXISTING_TUNNEL_PID ?? 0);
const publicEnv = {
  ...process.env,
  MUNI_FRONTEND_ORIGIN: `http://127.0.0.1:${publicFrontendPort}`,
};
let stopping = false;
let restartingFrontend = false;
let reloadTimer: NodeJS.Timeout | undefined;
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

function spawnFrontend() {
  const child = spawn(process.execPath, [
    path.join(root, "node_modules", "vinext", "dist", "cli.js"),
    "start",
    "--hostname", "127.0.0.1",
    "--port", publicFrontendPort,
  ], {
    cwd: root,
    env: publicEnv,
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => {
    lifecycle("child_error", { child: "frontend", errorName: error.name });
    console.error(error.message);
    if (!stopping) stop(1);
  });
  lifecycle("child_started", { child: "frontend", childPid: child.pid });
  child.on("exit", (code, signal) => {
    lifecycle("child_exit", { child: "frontend", childPid: child.pid, exitCode: code, signal });
    if (!stopping && !restartingFrontend) stop(code ?? 1);
  });
  return child;
}

let frontend = spawnFrontend();
const gateway = spawn(process.execPath, [tsxCli, path.join(root, "scripts", "public-gateway.ts")], {
  cwd: root,
  env: publicEnv,
  stdio: "inherit",
  windowsHide: true,
});
const tunnelArguments = [
  "tunnel",
  "--protocol", "http2",
  "--url", "http://127.0.0.1:4400",
  "--no-autoupdate",
];
if (existsSync(quickTunnelConfig)) tunnelArguments.splice(1, 0, "--config", quickTunnelConfig);
const tunnel = reuseTunnel ? null : spawn(cloudflared, tunnelArguments, {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});

function restartFrontend() {
  if (stopping || restartingFrontend) return;
  restartingFrontend = true;
  const previous = frontend;
  previous.once("exit", () => {
    if (stopping) return;
    frontend = spawnFrontend();
    restartingFrontend = false;
    console.log("むに Watch public frontend reloaded; tunnel URL unchanged.");
  });
  previous.kill();
}

watchFile(serverEntry, { interval: 500 }, (current, previous) => {
  if (!current.mtimeMs || current.mtimeMs === previous.mtimeMs) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(restartFrontend, 900);
});

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  lifecycle("shutdown_requested", { exitCode: code });
  clearTimeout(reloadTimer);
  unwatchFile(serverEntry);
  frontend.kill();
  gateway.kill();
  tunnel?.kill();
  if (reuseTunnel && existingTunnelPid > 0) {
    try { process.kill(existingTunnelPid); } catch {}
  }
  setTimeout(() => process.exit(code), 250);
}

for (const child of [gateway, tunnel].filter((child): child is NonNullable<typeof child> => child !== null)) {
  const name = child === gateway ? "gateway" : "tunnel";
  lifecycle("child_started", { child: name, childPid: child.pid });
  child.on("error", (error) => {
    lifecycle("child_error", { child: name, errorName: error.name });
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    lifecycle("child_exit", { child: name, childPid: child.pid, exitCode: code, signal });
    if (!stopping && (code || signal)) stop(code ?? 1);
  });
}

if (reuseTunnel) {
  console.log(`Reusing Cloudflare tunnel PID ${existingTunnelPid || "unmanaged"}; public URL stays unchanged.`);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
