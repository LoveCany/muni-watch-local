import { unityBridgeSource, rankingReaderSource } from "./il2cpp-agent.ts";

export const requiredRuntimeApis = [
  "il2cpp_gchandle_new", "il2cpp_object_get_class", "il2cpp_thread_attach", "il2cpp_class_from_name",
  "il2cpp_runtime_invoke", "il2cpp_domain_get_assemblies", "il2cpp_domain_get", "il2cpp_thread_detach",
  "il2cpp_string_new", "il2cpp_array_new", "il2cpp_assembly_get_image", "il2cpp_class_get_method_from_name",
  "il2cpp_object_new", "il2cpp_class_get_type", "il2cpp_gchandle_free", "il2cpp_type_get_object",
] as const;
import type { RuntimeProfile } from "./types.ts";

function record(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid runtime profile: ${where}`);
  const object = value as Record<string, unknown>;
  if (keys.some(key => !(key in object)) || Object.keys(object).some(key => !keys.includes(key)))
    throw new Error(`Invalid runtime profile keys: ${where}`);
  return object;
}
function integer(value: unknown, where: string, max = 0x7fffffff) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error(`Invalid runtime profile integer: ${where}`);
}
function offsets(value: unknown, keys: readonly string[], where: string) {
  const object = record(value, keys, where);
  for (const key of keys) integer(object[key], `${where}.${key}`, 4095);
  return object;
}
function guard(value: unknown, where: string) {
  const object = record(value, ["rva", "guard"], where);
  integer(object.rva, `${where}.rva`);
  if (typeof object.guard !== "string" || !/^[0-9a-f]{16}$/.test(object.guard))
    throw new Error(`Invalid runtime profile instruction guard: ${where}`);
}
export function validateRuntimeProfile(value: unknown): RuntimeProfile {
  const p = record(value, ["schemaVersion", "label", "pointerSize", "buildGuard", "nativeBridge", "javaVM", "api", "layout"], "root");
  if (p.schemaVersion !== 1 || p.pointerSize !== 8) throw new Error("Unsupported runtime profile schema or pointer size");
  if (typeof p.label !== "string" || !p.label.trim() || p.label.length > 128) throw new Error("Invalid runtime profile label");
  guard(p.buildGuard, "buildGuard");
  const bridge = record(p.nativeBridge, ["version", "loadLibrary", "getTrampoline", "guestMapPrefix"], "nativeBridge");
  for (const key of ["version", "loadLibrary", "getTrampoline"]) integer(bridge[key], `nativeBridge.${key}`, 4095);
  if (typeof bridge.guestMapPrefix !== "string" || !/^[0-9a-f]{1,16}$/.test(bridge.guestMapPrefix))
    throw new Error("Invalid runtime profile guest map prefix");
  const vm = record(p.javaVM, ["getEnv", "attachCurrentThread", "detachCurrentThread", "jniVersion"], "javaVM");
  for (const key of Object.keys(vm)) integer(vm[key], `javaVM.${key}`);
  const apis = record(p.api, requiredRuntimeApis, "api");
  for (const name of requiredRuntimeApis) guard(apis[name], `api.${name}`);
  const layout = record(p.layout, ["array", "string", "boxedValue", "methodInfo", "fields"], "layout");
  const array = offsets(layout.array, ["length", "data"], "layout.array");
  if (Number(array.length) + 8 > Number(array.data) || Number(array.data) % 8) throw new Error("Invalid runtime array layout");
  const string = offsets(layout.string, ["length", "data"], "layout.string");
  if (Number(string.length) + 4 > Number(string.data) || Number(string.data) % 2) throw new Error("Invalid runtime string layout");
  integer(layout.boxedValue, "layout.boxedValue", 4095);
  const method = offsets(layout.methodInfo, ["size", "methodPointer", "virtualMethodPointer", "parameterCount", "flags", "staticMask"], "layout.methodInfo");
  for (const [key, width] of [["methodPointer", 8], ["virtualMethodPointer", 8], ["parameterCount", 1], ["flags", 2]] as const)
    if (Number(method[key]) + width > Number(method.size)) throw new Error("Invalid runtime MethodInfo layout");
  offsets(layout.fields, ["rankingViewListManager", "rankingPresenterMaster", "rankingPresenterCurrentCell", "rankingCellName",
    "eventMasterId", "rankingDataRank", "rankingDataProfile", "rankingDataPt", "userProfileNickname"], "layout.fields");
  return value as RuntimeProfile;
}

export function createRuntimeAgentSource(profile: unknown, helperPath: string, helper: Buffer): string {
  const runtime = validateRuntimeProfile(profile);
  // The native callback skips the managed array header before reading its fixed task payload.
  if (helper.length < 0x50c || helper.toString("ascii", 0x500, 0x508) !== "MWABI001" ||
      helper.readUInt32LE(0x508) !== runtime.layout.array.data)
    throw new Error("Rebuild unity_invoke.so for the configured managed array layout");
  return unityBridgeSource.replace("__CONFIG__", () => JSON.stringify({ helperPath, runtime })) + rankingReaderSource;
}
