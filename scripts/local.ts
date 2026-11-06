import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceDiagnostics, recordProcessLifecycle } from "../collector/service-diagnostics.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lifecycle = createServiceDiagnostics(root, "local_launcher");
recordProcessLifecycle(lifecycle);
const env = { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" };
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const children = [
  spawn(process.execPath, [path.join(root, "node_modules", "vinext", "dist", "cli.js"), "dev", "--host", "127.0.0.1", "--port", "3002"], { cwd: root, env, stdio: "inherit" }),
  spawn(process.execPath, [tsxCli, path.join(root, "collector", "server.ts")], { cwd: root, env, stdio: "inherit" }),
];

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  lifecycle("shutdown_requested", { exitCode: code });
  const collector = children[1];
  let exitCode = code;
  if (collector.exitCode === null && collector.signalCode === null) {
    const finished = new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => resolve(false), 45000);
      collector.once("exit", () => { clearTimeout(timeout); resolve(true); });
    });
    try {
      const response = await fetch("http://127.0.0.1:4317/api/shutdown", { method: "POST", signal: AbortSignal.timeout(5000) });
      if (response.status !== 202) throw new Error("Collector rejected shutdown");
    } catch { lifecycle("collector_shutdown_request_failed"); collector.kill(); exitCode = 1; }
    if (!(await finished)) {
      lifecycle("collector_shutdown_timed_out");
      collector.kill(); exitCode = 1;
    }
  }
  children[0].kill();
  setTimeout(() => process.exit(exitCode), 250);
}

for (const [index, child] of children.entries()) {
  const name = index === 0 ? "frontend" : "collector";
  lifecycle("child_started", { child: name, childPid: child.pid });
  child.on("error", error => {
    lifecycle("child_error", { child: name, errorName: error.name });
    console.error(`Local ${name} failed to start; other services remain running`);
  });
  child.on("exit", (exitCode, signal) => {
    lifecycle("child_exit", { child: name, childPid: child.pid, exitCode, signal });
    if (!stopping) console.error(`Local ${name} exited; other services remain running`);
  });
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
