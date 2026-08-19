export type Point = { x: number; y: number };
export type Rectangle = { left: number; top: number; width: number; height: number };

export type OcrConfig = {
  pythonPath: string;
  modelName: string;
  modelDirectory: string;
  device: string;
  batchSize: number;
  timeoutMs: number;
};

export type MuniConfig = {
  adbPath: string;
  serial: string;
  deviceName: string;
  eventName: string;
  leaderboard: string;
  screen: { width: number; height: number };
  maxEntries: number;
  intervalMinutes: number;
  auto: boolean;
  waitAfterBackMs: number;
  waitAfterRankingMs: number;
  waitAfterTop20Ms: number;
  taps: { back: Point; ranking: Point; top20: Point };
  ocr: OcrConfig;
  nameCorrections: Record<string, string>;
};

export type RankingEntry = { rank: number; name: string; score: number; confidence?: number };
export type Capture = { id: string; capturedAt: string; entries: RankingEntry[] };
export type CollectorState = {
  status: "booting" | "capturing" | "idle" | "error";
  lastUpdated: string | null;
  lastError: string | null;
  history: Capture[];
  mumu: { name: string; connected: boolean; screen: string };
  ocr: { engine: string; model: string; device: string; gpu: string } | null;
};

export type OcrCandidate = { text: string; confidence: number; variant?: string };
export type RecognizedEntry = {
  rank: number;
  name: { text: string; confidence: number };
  scoreCandidates: OcrCandidate[];
};
export type OcrEngineInfo = { engine: string; model: string; device: string; gpu: string };
export type RecognitionResult = { entries: RecognizedEntry[]; engine: OcrEngineInfo };
export type OcrRow = { rank: number; name: Rectangle; score: Rectangle };
