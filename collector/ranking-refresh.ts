import sharp from "sharp";
import type { MuniConfig, Point } from "./types.ts";

export const landscape1080 = {
  screen: { width: 1920, height: 1080 },
  taps: { back: { x: 75, y: 60 }, ranking: { x: 655, y: 400 }, top20: { x: 960, y: 280 } },
};

export async function isRankingImage(imagePath: string, screen: MuniConfig["screen"]) {
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  if (metadata.width !== screen.width || metadata.height !== screen.height)
    throw new Error("Emulator resolution does not match the configured refresh layout");
  // The landscape title panel differs from the original square-screen layout.
  const marker = screen.width === 1920 && screen.height === 1080
    ? { left: 700, top: 185 } : { left: 300, top: 120 };
  const data = await image.extract({ ...marker, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  const purple = data[2] > 130 && data[1] < 105 && data[0] < 145;
  if (!purple || screen.width !== 1920 || screen.height !== 1080) return purple;
  // Notices use the same purple background, but do not have this ranking title edge.
  const edge = await sharp(imagePath).extract({ left: 166, top: 185, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  return edge[0] < 140 && edge[1] > 160 && edge[2] > 160;
}
export async function isTop20Image(imagePath: string, screen: MuniConfig["screen"]) {
  if (!(await isRankingImage(imagePath, screen))) return false;
  if (screen.width !== 1920 || screen.height !== 1080) return true;
  const data = await sharp(imagePath).extract({ left: 1180, top: 280, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  return data[0] > 160 && data[1] < 90 && data[2] > 140;
}

type RefreshConfig = Pick<MuniConfig, "taps" | "waitAfterBackMs" | "waitAfterRankingMs" | "waitAfterTop20Ms">;
type RefreshActions = {
  screenshot(): Promise<void>;
  isRanking(): Promise<boolean>;
  isTop20?(): Promise<boolean>;
  tap(point: Point): Promise<void>;
  wait(ms: number): Promise<void>;
};
export async function refreshTop20(config: RefreshConfig, actions: RefreshActions) {
  await actions.screenshot();
  // Scores stay cached while the ranking view remains open.
  if (await actions.isRanking()) {
    await actions.tap(config.taps.back);
    await actions.wait(config.waitAfterBackMs);
    await actions.screenshot();
    if (await actions.isRanking()) throw new Error("Could not leave the ranking screen");
  }
  await actions.tap(config.taps.ranking);
  await actions.wait(config.waitAfterRankingMs);
  // A slow ranking response can keep the tabs disabled after the fixed delay.
  for (let attempt = 0; attempt < 20; attempt++) {
    await actions.screenshot();
    if (await actions.isRanking()) break;
    if (attempt === 19) throw new Error("Ranking screen did not load in time");
    await actions.wait(500);
  }
  await actions.tap(config.taps.top20);
  await actions.wait(config.waitAfterTop20Ms);
  await actions.screenshot();
  if (actions.isTop20) {
    for (let attempt = 0; !(await actions.isTop20()); attempt++) {
      if (attempt === 19) throw new Error("TOP20 tab did not become active in time");
      await actions.tap(config.taps.top20);
      await actions.wait(500);
      await actions.screenshot();
    }
  }
  if (!(await actions.isRanking())) throw new Error("Could not open TOP20; return the game to the event home screen");
}
