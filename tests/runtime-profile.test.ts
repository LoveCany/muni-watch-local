import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createRuntimeAgentSource, validateRuntimeProfile } from "../collector/runtime-profile.ts";
import type { RuntimeProfile } from "../collector/types.ts";

const profile = validateRuntimeProfile(JSON.parse(await readFile(new URL("../config/il2cpp-runtime.json", import.meta.url), "utf8")));
function helper(p: RuntimeProfile) {
  const bytes = Buffer.alloc(0x50c);
  bytes.write("MWABI001", 0x500, "ascii"); bytes.writeUInt32LE(p.layout.array.data, 0x508);
  return bytes;
}
function sandbox(p: RuntimeProfile, corruptApi = false) {
  const bytes = Object.fromEntries(Object.values(p.api).map(({ rva, guard }) => [rva, [...Buffer.from(guard, "hex")]]));
  if (corruptApi) bytes[p.api.il2cpp_runtime_invoke.rva][0] ^= 255;
  const context = vm.createContext({ nativeBytes: bytes, rpc: { exports: {} }, send: () => {} });
  vm.runInContext(`
    const memory=new Map();
    class Pointer {
      constructor(address) {this.address=Number(address);}
      add(offset) {return new Pointer(this.address+offset);}
      isNull() {return this.address===0;}
      readByteArray() {if(!nativeBytes[this.address]) throw Error('Unexpected native address'); return new Uint8Array(nativeBytes[this.address]).buffer;}
      readPointer() {if(!memory.has(this.address)) throw Error('Unexpected pointer offset');return ptr(memory.get(this.address));}
      readU64() {return this.readS32();}
      readU32() {return this.readS32();}
      readS32() {if(!memory.has(this.address)) throw Error('Unexpected integer offset');return memory.get(this.address);}
      readUtf16String() {if(!memory.has(this.address)) throw Error('Unexpected string offset');return memory.get(this.address);}
      writePointer(value) {memory.set(this.address,value.address);}
      writeU32(value) {memory.set(this.address,value);}
      writeByteArray(value) {memory.set(this.address,value);}
    }
    function ptr(value) {return new Pointer(value);}
    const Process={arch:'arm64',pointerSize:8,enumerateThreads:()=>[{name:'UnityMain',id:1}],getModuleByName:()=>({base:ptr(0)})};
    const Module={getGlobalExportByName:()=>ptr(0)};
    const Memory={allocUtf8String:value=>value};
    function NativeFunction() {return ()=>ptr(1);}
  `, context);
  return context;
}

test("runtime profile rejects missing APIs, malformed guards and invalid object layouts before injection", () => {
  const missing = structuredClone(profile); delete (missing.api as Partial<typeof missing.api>).il2cpp_runtime_invoke;
  assert.throws(() => validateRuntimeProfile(missing), /keys: api/);
  const bad = structuredClone(profile); bad.api.il2cpp_runtime_invoke.guard = "invalid";
  assert.throws(() => validateRuntimeProfile(bad), /instruction guard/);
  const overlap = structuredClone(profile); overlap.layout.array.data = 16;
  assert.throws(() => validateRuntimeProfile(overlap), /array layout/);
  const method = structuredClone(profile); method.layout.methodInfo.size = 8;
  assert.throws(() => validateRuntimeProfile(method), /MethodInfo/);
  assert.throws(() => createRuntimeAgentSource(profile, "/synthetic/helper.so", Buffer.alloc(0x50c)), /Rebuild/);
  const mismatch = helper(profile); mismatch.writeUInt32LE(profile.layout.array.data + 8, 0x508);
  assert.throws(() => createRuntimeAgentSource(profile, "/synthetic/helper.so", mismatch), /Rebuild/);
});

test("agent preflights configured native addresses and refuses changed instructions", () => {
  const relocated = structuredClone(profile);
  for (const api of Object.values(relocated.api)) api.rva += 0x1000;
  const source = createRuntimeAgentSource(relocated, "/synthetic/helper.so", helper(relocated));
  assert.doesNotThrow(() => vm.runInContext(source, sandbox(relocated)));
  assert.throws(() => vm.runInContext(source, sandbox(relocated, true)), /API guard failed: il2cpp_runtime_invoke/);
});

test("callback mapping recognizes a previously loaded deleted inode without matching a different helper", () => {
  const context = sandbox(profile);
  vm.runInContext(createRuntimeAgentSource(profile, "/synthetic/helper.so", helper(profile)), context);
  const deleted = "40002ec40000-40002ec42000 r--p 00000000 08:23 123 /synthetic/helper.so (deleted)";
  context.syntheticMaps = deleted;
  assert.equal(vm.runInContext("findHelperMapping(syntheticMaps)", context), deleted);
  context.syntheticMaps = deleted.replace("helper.so", "different.so");
  assert.equal(vm.runInContext("findHelperMapping(syntheticMaps)", context), undefined);
});

test("real ranking reader uses configured array, string and field offsets", () => {
  const changed = structuredClone(profile);
  changed.layout.array = { length: 40, data: 48 };
  changed.layout.string = { length: 24, data: 28 };
  for (const key of Object.keys(changed.layout.fields) as (keyof typeof changed.layout.fields)[]) changed.layout.fields[key] += 16;
  const context = sandbox(changed);
  vm.runInContext(createRuntimeAgentSource(changed, "/synthetic/helper.so", helper(changed)), context);
  vm.runInContext(`
    klass=(namespace,name)=>name;
    objectClass=object=>({equals:expected=>memory.get('class:'+object.address)===expected});
    const array=10000;
    memory.set(array+layout.array.length,20);
    for(let i=0;i<20;i++) {
      const row=20000+i*1000,profile=50000+i*1000,name=80000+i*1000;
      memory.set(array+layout.array.data+i*runtime.pointerSize,row);
      memory.set('class:'+row,'EventRankingData');memory.set('class:'+profile,'UserProfile');
      memory.set(row+layout.fields.rankingDataRank,i+1);memory.set(row+layout.fields.rankingDataPt,100000-i);
      memory.set(row+layout.fields.rankingDataProfile,profile);memory.set(profile+layout.fields.userProfileNickname,name);
      const text='Synthetic player '+(i+1);
      memory.set(name+layout.string.length,text.length);memory.set(name+layout.string.data,text);
    }
  `, context);
  const rows: unknown = JSON.parse(JSON.stringify(vm.runInContext("readRows(ptr(10000))", context)));
  assert.deepEqual(rows, Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, score: 100000 - i, name: `Synthetic player ${i + 1}` })));
});

test("queued invocation takes every native callback target from the runtime profile", () => {
  const changed = structuredClone(profile);
  for (const api of Object.values(changed.api)) api.rva += 0x2000;
  changed.layout.array.data = 48;
  const context = sandbox(changed);
  vm.runInContext(createRuntimeAgentSource(changed, "/synthetic/helper.so", helper(changed)), context);
  vm.runInContext(`
    let allocation=100000;
    const allocate=()=>{const object=ptr(allocation);allocation+=1000;
      for(let offset=0;offset<200;offset+=4) memory.set(object.address+offset,0);return object;};
    api=name=>{if(name!=='il2cpp_array_new') throw Error('Unexpected allocation API');return allocate;};
    hold=()=>{};klass=()=>ptr(1);objectClass=()=>ptr(1);managedBytes=allocate;
    attachWorker=()=>{};detachWorker=()=>{};queueContext=ptr(1);
    invokeRaw=(owner,name,instance,args)=>{
      const data=args[1].add(layout.array.data);
      memory.set('postedTargets',[data.readPointer().address,data.add(48).readPointer().address,data.add(64).readPointer().address]);
      data.add(96).writeU32(1);
    };
    invoke(ptr(1),'SyntheticMethod');
  `, context);
  const targets: unknown = JSON.parse(JSON.stringify(vm.runInContext("memory.get('postedTargets')", context)));
  assert.deepEqual(targets, [changed.api.il2cpp_runtime_invoke.rva, changed.api.il2cpp_gchandle_new.rva,
    changed.api.il2cpp_class_get_method_from_name.rva]);
});
