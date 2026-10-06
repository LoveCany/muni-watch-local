import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { parseMuniConfig } from "../collector/config.ts";
import { createIl2CppClient } from "../collector/il2cpp-client.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRankingImage, isTop20Image, landscape1080, refreshTop20 } from "../collector/ranking-refresh.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = parseMuniConfig(await readFile(path.join(root, "config/muni.yml"), "utf8"));
if (process.argv.includes("--landscape-1080")) Object.assign(config, landscape1080);
const execute = promisify(execFile);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function refresh() {
  const image = path.join(root, "data/il2cpp-probe-screen.png");
  const remote = "/sdcard/muni-il2cpp-probe.png";
  async function adb(...args: string[]) {
    await execute(config.adbPath, ["-s", config.serial, ...args], { timeout: 15000, windowsHide: true });
  }
  await mkdir(path.join(root, "data"), { recursive: true });
  await refreshTop20(config, {
    screenshot: async () => { await adb("shell", "screencap", "-p", remote); await adb("pull", remote, image); },
    isRanking: () => isRankingImage(image, config.screen),
    isTop20: () => isTop20Image(image, config.screen),
    tap: ({ x, y }) => adb("shell", "input", "tap", String(x), String(y)),
    wait,
  });
}
for (const [flag, key] of [["--adb", "adbPath"], ["--serial", "serial"]] as const) {
  const index = process.argv.indexOf(flag);
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing ${flag} argument`);
    config[key] = value;
  }
}
const client = createIl2CppClient(root, config, (stage) => {
  if (process.argv.includes("--trace")) console.log(JSON.stringify({ stage }));
});
try {
  const countIndex = process.argv.indexOf("--count");
  const count = countIndex < 0 ? 1 : Number(process.argv[countIndex + 1]);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("--count must be between 1 and 10");
  for (let index = 0; index < count; index++) {
    if (process.argv.includes("--refresh")) await refresh();
    const result = await client.capture();
    await mkdir(path.join(root, "data"), { recursive: true });
    const output = path.join(root, "data/il2cpp-probe.json");
    await writeFile(output+".tmp", JSON.stringify({ capturedAt: result.capturedAt, entries: result.entries }, null, 2)+"\n");
    await rename(output+".tmp", output);
    console.log(JSON.stringify({ capturedAt: result.capturedAt, entries: result.entries.length, source: "il2cpp" }));
    if (index + 1 < count) await wait(config.intervalMinutes * 60000);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Ranking probe failed");
  process.exitCode = 1;
} finally {
  try { await client.close(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Ranking reader cleanup failed");
    process.exitCode = 1;
  }
}

