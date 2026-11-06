import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type Details = { child?: string; childPid?: number; exitCode?: number | null; signal?: string | null; errorName?: string; errorCode?: string };

export function createServiceDiagnostics(root: string, service: string) {
  const directory = path.join(root, "data", "service-logs");
  mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${service}-${process.pid}.jsonl`);
  return (event: string, details: Details = {}) => {
    try {
      appendFileSync(filename, JSON.stringify({ at: new Date().toISOString(), service, event, pid: process.pid, parentPid: process.ppid, ...details }) + "\n");
    } catch { console.error("Could not write local service lifecycle diagnostics"); }
  };
}

export function recordProcessLifecycle(log: ReturnType<typeof createServiceDiagnostics>) {
  log("started");
  process.on("exit", exitCode => log("exit", { exitCode }));
  // Observe fatal errors without changing Node's crash behavior or recording application data.
  process.on("uncaughtExceptionMonitor", error => {
    const code = (error as NodeJS.ErrnoException).code;
    log("uncaught_exception", { errorName: error.name, errorCode: code && /^[A-Z0-9_]+$/.test(code) ? code : undefined });
  });
}

export async function runBackgroundCapture(operation: () => Promise<unknown>, failed: (error: unknown) => void) {
  try { await operation(); }
  catch (error) { failed(error); }
}
