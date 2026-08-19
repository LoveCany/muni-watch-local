import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { OcrConfig, OcrEngineInfo, OcrRow, RecognitionResult, RecognizedEntry } from "./types.ts";

const MARKER = "@@MUNI_PPOCR@@";
type WorkerMessage = OcrEngineInfo & { type: "ready" } | { type: "result"; id: string; entries: RecognizedEntry[] } | { type: "error"; id: string; error: string };
type PendingRequest = { resolve: (result: RecognitionResult) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout };

export function createPpOcrClient({ root, config }: { root: string; config: OcrConfig }) {
  let processHandle: ChildProcessWithoutNullStreams | null = null;
  let readyPromise: Promise<OcrEngineInfo> | null = null;
  let readyInfo: OcrEngineInfo | null = null;
  let requestSequence = 0;
  const pending = new Map<string, PendingRequest>();
  const stderrTail: string[] = [];

  function rejectAll(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  }

  function start(): Promise<OcrEngineInfo> {
    if (readyPromise) return readyPromise;
    const pythonPath = path.resolve(root, config.pythonPath);
    const workerPath = path.join(root, "collector", "ppocr_worker.py");
    const modelDirectory = path.resolve(root, config.modelDirectory);
    if (!existsSync(pythonPath)) throw new Error(`PP-OCR Python環境がありません: ${pythonPath}`);

    readyPromise = new Promise<OcrEngineInfo>((resolve, reject) => {
      const startupTimeout = setTimeout(() => {
        processHandle?.kill();
        reject(new Error(`PP-OCRの起動が${config.timeoutMs}ms以内に完了しませんでした`));
      }, config.timeoutMs);
      const child = spawn(pythonPath, [
        workerPath, "--model", config.modelName, "--model-dir", modelDirectory,
        "--device", config.device, "--batch-size", String(config.batchSize),
      ], {
        cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env, PYTHONUTF8: "1", PADDLE_PDX_CACHE_HOME: path.join(root, "data", "ppocr-models"),
          PADDLE_PDX_MODEL_SOURCE: "BOS", PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
          FLAGS_allocator_strategy: "auto_growth",
        },
      });
      processHandle = child;

      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (!line.startsWith(MARKER)) return;
        let message: WorkerMessage;
        try { message = JSON.parse(line.slice(MARKER.length)) as WorkerMessage; }
        catch { return; }
        if (message.type === "ready") {
          clearTimeout(startupTimeout);
          readyInfo = { engine: message.engine, model: message.model, device: message.device, gpu: message.gpu };
          resolve(readyInfo);
          return;
        }
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timeout);
        if (message.type === "error") request.reject(new Error(`PP-OCR認識エラー: ${message.error}`));
        else if (readyInfo) request.resolve({ entries: message.entries, engine: readyInfo });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail.push(...String(chunk).split(/\r?\n/).filter(Boolean));
        if (stderrTail.length > 30) stderrTail.splice(0, stderrTail.length - 30);
      });
      child.on("error", (error) => { clearTimeout(startupTimeout); reject(error); });
      child.on("exit", (code, signal) => {
        clearTimeout(startupTimeout);
        const details = stderrTail.slice(-5).join(" | ");
        rejectAll(new Error(`PP-OCRプロセスが終了しました (${code ?? signal})${details ? `: ${details}` : ""}`));
        processHandle = null; readyPromise = null; readyInfo = null;
      });
    });
    return readyPromise;
  }

  async function recognize({ imagePath, rows }: { imagePath: string; rows: OcrRow[] }): Promise<RecognitionResult> {
    await start();
    const id = `${Date.now()}-${requestSequence += 1}`;
    return new Promise<RecognitionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`PP-OCR認識が${config.timeoutMs}msでタイムアウトしました`));
      }, config.timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      processHandle!.stdin.write(`${JSON.stringify({ id, imagePath, rows })}\n`, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timeout); pending.delete(id); reject(error);
      });
    });
  }

  async function close(): Promise<void> {
    rejectAll(new Error("PP-OCRプロセスを停止しました"));
    processHandle?.kill();
    processHandle = null; readyPromise = null; readyInfo = null;
  }

  return { start, recognize, close, get info() { return readyInfo; } };
}
