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
  captureMode: "ocr" | "il2cpp";
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
export type LeaderboardId = "total_pt" | "daily_pt" | "poker_coin";
export type BoardState = { name: string; dayNumber: number; history: Capture[]; lastUpdated: string | null };
export type RuntimeRankingResult = { capturedAt: string; entries: RankingEntry[]; eventId: number;
  board: LeaderboardId; rankingName: string; dayNumber: number };
export type CollectorState = {
  eventId?: number;
  boards?: Partial<Record<LeaderboardId, BoardState>>;
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

export type RuntimeApiName =
  | "il2cpp_gchandle_new"
  | "il2cpp_object_get_class"
  | "il2cpp_thread_attach"
  | "il2cpp_class_from_name"
  | "il2cpp_runtime_invoke"
  | "il2cpp_domain_get_assemblies"
  | "il2cpp_domain_get"
  | "il2cpp_thread_detach"
  | "il2cpp_string_new"
  | "il2cpp_array_new"
  | "il2cpp_assembly_get_image"
  | "il2cpp_class_get_method_from_name"
  | "il2cpp_object_new"
  | "il2cpp_class_get_type"
  | "il2cpp_gchandle_free"
  | "il2cpp_type_get_object";
type Guard = { rva: number; guard: string };
export type RuntimeProfile = {
  schemaVersion: 1; label: string; pointerSize: 8; buildGuard: Guard;
  nativeBridge: { version: number; loadLibrary: number; getTrampoline: number; guestMapPrefix: string };
  javaVM: { getEnv: number; attachCurrentThread: number; detachCurrentThread: number; jniVersion: number };
  api: Record<RuntimeApiName, Guard>;
  layout: {
    array: { length: number; data: number }; string: { length: number; data: number }; boxedValue: number;
    methodInfo: { size: number; methodPointer: number; virtualMethodPointer: number; parameterCount: number; flags: number; staticMask: number };
    fields: { rankingViewListManager: number; rankingPresenterMaster: number; rankingPresenterCurrentCell: number;
      rankingCellName: number; eventMasterId: number; rankingDataRank: number; rankingDataProfile: number;
      rankingDataPt: number; userProfileNickname: number };
  };
};
