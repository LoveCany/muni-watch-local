export const unityBridgeSource = String.raw`// Runtime addresses and layouts are validated before managed calls.
const config = __CONFIG__;
const runtime = config.runtime;
const layout = runtime.layout;
const nil = ptr(0);
let library = null;
let nativeBridge = null;
let javaVM = null;
const functions = new Map();
const handles = [];

let queueContext = nil, queueDelegate = nil, guestBase = nil, callbackMethod = nil;
let helperHandle = nil;
let jniEnv = nil, dispatcher = null;
let jniOwned = false;
let workerThread = nil;
let pendingCall = null;
let pendingRelease = null;
const dispatcherName=Memory.allocUtf8String('D4DJJniDispatch');
const dispatcherSignature=Memory.allocUtf8String('JJ');
const classCache = new Map();
const main = Process.enumerateThreads().find(t => t.name === 'UnityMain');
if (!main) throw new Error('UnityMain is not running');
if (Process.pointerSize !== runtime.pointerSize) throw new Error('Only the validated 64-bit layout is supported');

if (Process.arch === 'x64') {
    const mapping = File.readAllText('/proc/self/maps').split('\n').find(
        line => /\blibil2cpp\.so$/.test(line) && /r--p 00000000 /.test(line) && line.startsWith(runtime.nativeBridge.guestMapPrefix));
    if (!mapping) throw new Error('No MuMu ARM64 IL2CPP mapping');
    const base = ptr('0x' + mapping.split('-')[0]);
    guestBase = base;
    const signature = Array.from(new Uint8Array(base.add(runtime.buildGuard.rva).readByteArray(8)),
        n => n.toString(16).padStart(2, '0')).join('');
    if (signature !== runtime.buildGuard.guard) throw new Error('Unsupported IL2CPP build');
    const itf = Process.getModuleByName('libhoudini.so').getExportByName('NativeBridgeItf');
    if (itf.readU32() !== runtime.nativeBridge.version) throw new Error('Unsupported MuMu native bridge version');
    const load = new NativeFunction(itf.add(runtime.nativeBridge.loadLibrary).readPointer(), 'pointer', ['pointer','int','pointer']);
    library = load(Memory.allocUtf8String(mapping.slice(mapping.indexOf('/data/'))), 2, nil);
    if (library.isNull()) throw new Error('The existing IL2CPP library is unavailable to the bridge');
    nativeBridge = new NativeFunction(itf.add(runtime.nativeBridge.getTrampoline).readPointer(), 'pointer',
        ['pointer','pointer','pointer','uint32','int']);
    helperHandle = load(Memory.allocUtf8String(config.helperPath), 2, nil);
    if(helperHandle.isNull()) throw new Error('The main-thread callback helper did not load');
    const entry=nativeBridge(helperHandle,dispatcherName,dispatcherSignature,2,1);
    if(entry.isNull()) throw new Error('The regular JNI dispatcher is unavailable');
    dispatcher=new NativeFunction(entry,'pointer',['pointer','pointer','uint64'],{exceptions:'propagate'});
    const vmBuffer = Memory.alloc(8), count = Memory.alloc(4);
    const getVM = new NativeFunction(Module.getGlobalExportByName('JNI_GetCreatedJavaVMs'),
        'int', ['pointer','int','pointer']);
    if (getVM(vmBuffer, 1, count) !== 0 || count.readS32() !== 1) throw new Error('Expected one Android VM');
    javaVM = vmBuffer.readPointer();
} else if (Process.arch !== 'arm64') {
    throw new Error('Unsupported process architecture');
} else {
    guestBase=Process.getModuleByName('libil2cpp.so').base;
    const dlopen=new NativeFunction(Module.getGlobalExportByName('dlopen'),'pointer',['pointer','int']);
    helperHandle=dlopen(Memory.allocUtf8String(config.helperPath),2);
}

function guardedApiAddress(name) {
    const metadata=runtime.api[name];
    if(!metadata) throw new Error('Missing guarded API: '+name);
    const address=guestBase.add(metadata.rva);
    const bytes=Array.from(new Uint8Array(address.readByteArray(8)),n=>n.toString(16).padStart(2,'0')).join('');
    if(bytes!==metadata.guard) throw new Error('IL2CPP API guard failed: '+name);
    return address;
}
// Validate every native target before allocating objects or posting a managed callback.
for(const name of Object.keys(runtime.api)) guardedApiAddress(name);
function api(name, result, arguments_, shorty) {
    if (!functions.has(name)) {
        if(dispatcher) {
            const address=guardedApiAddress(name);
            functions.set(name,{address,call:(...values)=>{
                const frame=Memory.alloc(48);
                frame.writePointer(address);
                for(let i=0;i<4;i++) frame.add(8+i*8).writePointer(i<values.length ?
                    (typeof values[i]==='number' ? ptr(values[i]) : values[i]) : nil);
                const returned=dispatcher(jniEnv,nil,new UInt64(frame.toString()));
                return result==='pointer' ? returned : result==='void' ? undefined : returned.toUInt32();
            }});
            return functions.get(name).call;
        }
        const address=guardedApiAddress(name);
        // Houdini enters its guest through a signal. Frida must let Houdini handle that signal.
        functions.set(name, {address,
            call:new NativeFunction(address,result,arguments_,{exceptions:'propagate'})});
    }
    return functions.get(name).call;
}
function attachJavaThread() {
    if (!javaVM) return;
    const env = Memory.alloc(8);
    const getEnv = new NativeFunction(javaVM.readPointer().add(runtime.javaVM.getEnv).readPointer(),
        'int', ['pointer','pointer','int']);
    const status=getEnv(javaVM,env,runtime.javaVM.jniVersion);
    if(status===0) {jniEnv=env.readPointer();return;}
    if(status!==-2) throw new Error('Cannot query the current JNI thread');
    const attach = new NativeFunction(javaVM.readPointer().add(runtime.javaVM.attachCurrentThread).readPointer(),
        'int', ['pointer','pointer','pointer']);
    if (attach(javaVM, env, nil) !== 0) throw new Error('Cannot use the bridge without an attached JNI thread');
    jniEnv=env.readPointer();
    jniOwned=true;
}
function detachJavaThread() {
    if(!jniOwned) return;
    const detach=new NativeFunction(javaVM.readPointer().add(runtime.javaVM.detachCurrentThread).readPointer(),'int',['pointer']);
    if(detach(javaVM)!==0) throw new Error('Cannot release owned JNI thread');
    jniOwned=false;jniEnv=nil;
}
function klass(namespace, name) {
    const key=namespace+'.'+name;
    if(classCache.has(key)) return classCache.get(key);
    const domain = api('il2cpp_domain_get','pointer',[],'J')();
    const size = Memory.alloc(8);
    const assemblies = api('il2cpp_domain_get_assemblies','pointer',['pointer','pointer'],'JJJ')(domain,size);
    const count = Number(size.readU64());
    if (count < 1 || count > 1000) throw new Error('Invalid assembly count');
    const ns = Memory.allocUtf8String(namespace), cn = Memory.allocUtf8String(name);
    for (let i=0;i<count;i++) {
        const image = api('il2cpp_assembly_get_image','pointer',['pointer'],'JJ')(assemblies.add(i*8).readPointer());
        const found = api('il2cpp_class_from_name','pointer',['pointer','pointer','pointer'],'JJJJ')(image,ns,cn);
        if (!found.isNull()) {classCache.set(key,found);return found;}
    }
    throw new Error('Missing class: ' + namespace + '.' + name);
}
function objectClass(object) {
    return api('il2cpp_object_get_class','pointer',['pointer'],'JJ')(object);
}
function method(owner,name,count) {
    const found=api('il2cpp_class_get_method_from_name','pointer',['pointer','pointer','int'],'JJJI')(
        owner,Memory.allocUtf8String(name),count);
    if(found.isNull()) throw new Error('Missing method: '+name);
    return found;
}
function invokeRaw(owner, name, instance=nil, args=[]) {
    const method = api('il2cpp_class_get_method_from_name','pointer',['pointer','pointer','int'],'JJJI')(
        owner, Memory.allocUtf8String(name), args.length);
    if (method.isNull()) throw new Error('Missing method: ' + name);
    const params = args.length ? Memory.alloc(args.length*8) : nil;
    args.forEach((argument,i)=>params.add(i*8).writePointer(argument));
    const error = Memory.alloc(8); error.writePointer(nil);
    const value = api('il2cpp_runtime_invoke','pointer',['pointer','pointer','pointer','pointer'],'JJJJJ')(
        method,instance,params,error);
    if (!error.readPointer().isNull()) throw new Error('Managed operation failed: ' + name);
    return value;
}
function invoke(owner,name,instance=nil,args=[]) {
    if(queueContext.isNull()) return invokeRaw(owner,name,instance,args);
    send({stage:'invoke_prepare',method:name});
    const state=api('il2cpp_array_new','pointer',['pointer','uint64'],'JJJ')(klass('System','Byte'),104);
    send({stage:'invoke_state_created',method:name});
    hold(state);
    send({stage:'invoke_state_rooted',method:name});
    const data=state.add(layout.array.data);
    const parameterOwner=args.length ? managedBytes(args.length*8) : nil;
    send({stage:'invoke_parameters_created',method:name});
    const parameters=parameterOwner.isNull() ? nil : parameterOwner.add(layout.array.data);
    args.forEach((argument,i)=>parameters.add(i*8).writePointer(argument));
    data.writePointer(guardedApiAddress('il2cpp_runtime_invoke'));
    const nameBytes=Array.from(name,c=>c.charCodeAt(0)).concat(0);
    const methodName=managedBytes(nameBytes.length).add(layout.array.data);
    methodName.writeByteArray(nameBytes);
    data.add(64).writePointer(guardedApiAddress('il2cpp_class_get_method_from_name'));
    data.add(72).writePointer(owner);
    data.add(80).writePointer(methodName);
    data.add(88).writeU32(args.length);
    data.add(16).writePointer(instance);
    data.add(24).writePointer(parameters);
    data.add(48).writePointer(guardedApiAddress('il2cpp_gchandle_new'));
    pendingCall={state,parameterOwner,args,parameters,name};
    send({stage:'invoke_post',method:name});
    invokeRaw(objectClass(queueContext),'Post',queueContext,[queueDelegate,state]);
    send({stage:'invoke_wait',method:name});
    detachWorker();
    const deadline=Date.now()+10000;
    while(data.add(96).readU32()===0) {
        if(Date.now()>=deadline) throw new Error('Unity main-thread queue timed out; callback roots remain retained');
        Thread.sleep(0.005);
    }
    attachWorker();
    const resultHandle=data.add(56).readPointer();
    if(!resultHandle.isNull()) handles.push(resultHandle);
    pendingCall=null;
    send({stage:'invoke_completed',method:name,completion:data.add(96).readU32()});
    if(data.add(96).readU32()===2) throw new Error('Missing managed method: '+name);
    if(!data.add(40).readPointer().isNull()) throw new Error('Managed operation failed: '+name);
    const result=data.add(32).readPointer();
    
    return result;
}
function managedBytes(length) {
    const value=api('il2cpp_array_new','pointer',['pointer','uint64'],'JJJ')(klass('System','Byte'),length);
    hold(value);
    return value;
}
function attachWorker() {
    if(!workerThread.isNull()) return;
    if(Process.getCurrentThreadId()===main.id) throw new Error('The controller must not reenter UnityMain');
    attachJavaThread();
    const domain=api('il2cpp_domain_get','pointer',[],'J')();
    workerThread=api('il2cpp_thread_attach','pointer',['pointer'],'JJ')(domain);
}
function detachWorker() {
    if(workerThread.isNull()) return;
    api('il2cpp_thread_detach','void',['pointer'],'VJ')(workerThread);
    workerThread=nil;
}
function findHelperMapping(maps) {
    return maps.split('\n').find(line =>
        line.replace(/ \(deleted\)$/, '').endsWith(config.helperPath) && /r--p 00000000 /.test(line) &&
        (Process.arch !== 'x64' || line.startsWith(runtime.nativeBridge.guestMapPrefix)));
}
function prepareQueue() {
    attachJavaThread();
    send({stage:'queue_domain'});
    const domain=api('il2cpp_domain_get','pointer',[],'J')();
    send({stage:'queue_attach_il2cpp'});
    workerThread=api('il2cpp_thread_attach','pointer',['pointer'],'JJ')(domain);
    send({stage:'queue_resolve_context'});
    const context=invokeRaw(klass('Cysharp.Threading.Tasks','PlayerLoopHelper'),'get_UnitySynchronizationContext');
    if(context.isNull()) throw new Error('Unity synchronization context is not initialized');
    send({stage:'queue_resolve_callback'});
    const mapping=findHelperMapping(File.readAllText('/proc/self/maps'));
    if(!mapping) throw new Error('Cannot identify the guest queue callback mapping');
    const helperBase=ptr('0x'+mapping.split('-')[0]);
    if(helperBase.add(0x500).readUtf8String(8)!=='MWABI001' || helperBase.add(0x508).readU32()!==layout.array.data)
        throw new Error('The loaded helper does not match the managed array layout');
    const helper=helperBase.add(0x1000);
    const template=method(klass('System','GC'),'KeepAlive',1);
    if(template.add(layout.methodInfo.parameterCount).readU8()!==1 || !(template.add(layout.methodInfo.flags).readU16() & layout.methodInfo.staticMask))
        throw new Error('Unexpected callback method metadata layout');
    callbackMethod=managedBytes(layout.methodInfo.size).add(layout.array.data);
    callbackMethod.writeByteArray(template.readByteArray(layout.methodInfo.size));
    callbackMethod.add(layout.methodInfo.methodPointer).writePointer(helper);
    callbackMethod.add(layout.methodInfo.virtualMethodPointer).writePointer(helper);
    const callbackClass=klass('System.Threading','SendOrPostCallback');
    send({stage:'queue_allocate_delegate'});
    queueDelegate=api('il2cpp_object_new','pointer',['pointer'],'JJ')(callbackClass);
    hold(queueDelegate);
    const methodValue=Memory.alloc(8);methodValue.writePointer(callbackMethod);
    invokeRaw(callbackClass,'.ctor',queueDelegate,[nil,methodValue]);
    send({stage:'queue_delegate_initialized'});
    hold(context);
    queueContext=context;
    send({stage:'main_thread_queue_ready'});
}
function string(value) {
    const result=api('il2cpp_string_new','pointer',['pointer'],'JJ')(Memory.allocUtf8String(value));
    hold(result);return result;
}
function boolean(value) {const p=managedBytes(1).add(layout.array.data);p.writeU8(value ? 1 : 0);return p;}



function arrayItems(array) {
    if (array.isNull()) return [];
    const count=Number(array.add(layout.array.length).readU64());
    if (count<0 || count>100000) throw new Error('Invalid managed array');
    return Array.from({length:count},(_,i)=>array.add(layout.array.data+i*runtime.pointerSize).readPointer());
}

function type(owner) {
    const result=api('il2cpp_type_get_object','pointer',['pointer'],'JJ')(
        api('il2cpp_class_get_type','pointer',['pointer'],'JJ')(owner));
    hold(result);return result;
}
function hold(object) {handles.push(api('il2cpp_gchandle_new','pointer',['pointer','uint8'],'IJZ')(object,0));}
`;

export const rankingReaderSource = String.raw`
let rootCount = 0;
function managedString(value) {
    if(value.isNull()) throw new Error('Missing ranking nickname');
    const length=value.add(layout.string.length).readS32();
    if(length<1 || length>256) throw new Error('Invalid ranking nickname length');
    return value.add(layout.string.data).readUtf16String(length);
}
function active(object) {
    const value=invoke(objectClass(object),'get_isActiveAndEnabled',object);
    return !value.isNull() && value.add(layout.boxedValue).readU8()!==0;
}
function fieldValue(object, name) {
    const reflectionType=type(objectClass(object));
    const flags=managedBytes(4).add(layout.array.data);flags.writeS32(52);
    const field=invoke(objectClass(reflectionType),'GetField',reflectionType,[string(name),flags]);
    if(field.isNull()) throw new Error('Missing ranking field: '+name);
    return invoke(objectClass(field),'GetValue',field,[object]);
}
function readRows(array) {
    const objects=arrayItems(array);
    if(objects.length!==20) throw new Error('The active list is not a complete TOP20 list');
    return objects.map(row=>{
        if(row.isNull() || !objectClass(row).equals(klass('','EventRankingData')))
            throw new Error('Unexpected ranking row class');
        const rank=row.add(layout.fields.rankingDataRank).readS32(), score=row.add(layout.fields.rankingDataPt).readS32();
        const profile=row.add(layout.fields.rankingDataProfile).readPointer();
        if(profile.isNull() || !objectClass(profile).equals(klass('Shared.Objects','UserProfile')))
            throw new Error('Unexpected ranking profile class');
        // Read only the public nickname; account IDs and other profile fields stay untouched.
        return {rank,score,name:managedString(profile.add(layout.fields.userProfileNickname).readPointer())};
    }).sort((a,b)=>a.rank-b.rank);
}
function releaseTemporary() {
    if(pendingRelease) throw new Error('A handle release batch remains unresolved');
    if(pendingCall) {
        const data=pendingCall.state.add(layout.array.data);
        if(data.add(96).readU32()===0) return false;
        const handle=data.add(56).readPointer();if(!handle.isNull())handles.push(handle);
        pendingCall=null;
    }
    if(handles.length<=rootCount) return true;
    // An attached controller must not wait on GC while Unity requests a safepoint.
    detachWorker();
    send({stage:'free_roots'});
    pendingRelease={handles:handles.slice(rootCount)};
    while(handles.length>rootCount) {
        const handle=handles[handles.length-1];
        api('il2cpp_gchandle_free','void',['pointer'],'VJ')(handle);
        handles.pop();
        pendingRelease.handles.pop();
    }
    pendingRelease=null;
    send({stage:'roots_released'});
    return true;
}

function readRanking() {
    try {
        if(queueContext.isNull()) {prepareQueue();rootCount=handles.length;}
        else attachWorker();
        if(!releaseTemporary()) throw new Error('A previous main-thread read is still pending');
        attachWorker();
        const views=arrayItems(invoke(klass('UnityEngine','Resources'),'FindObjectsOfTypeAll',nil,
            [type(klass('','EventRankingInfoCarouselCellView'))]));
        const live=views.filter(active);
        if(live.length!==1) throw new Error('Exactly one active event ranking view is required');
        const manager=live[0].add(layout.fields.rankingViewListManager).readPointer();
        if(manager.isNull() || !active(manager)) throw new Error('The ranking list is inactive');
        const array=fieldValue(manager,'_dataList');
        if(array.isNull()) throw new Error('The ranking list has not loaded');
        const presenters=arrayItems(invoke(klass('UnityEngine','Resources'),'FindObjectsOfTypeAll',nil,
            [type(klass('','EventRankingPresenter'))])).filter(active);
        if(presenters.length!==1) throw new Error('Exactly one active event ranking presenter is required');
        const presenter=presenters[0], master=presenter.add(layout.fields.rankingPresenterMaster).readPointer();
        const cell=presenter.add(layout.fields.rankingPresenterCurrentCell).readPointer();
        if(cell.isNull() || !objectClass(cell).equals(klass('','EventRankingInfoCarouselCellData')))
            throw new Error('Missing current ranking identity');
        const rankingName=managedString(cell.add(layout.fields.rankingCellName).readPointer());
        if(!['累計Ptランキング','デイリーPtランキング','POKER COINランキング'].includes(rankingName))
            throw new Error('Unsupported active event leaderboard');
        const dayNumber=rankingName==='デイリーPtランキング'
            ? invoke(objectClass(cell),'get_DayNumber',cell).add(layout.boxedValue).readS32() : 0;
        if(rankingName==='デイリーPtランキング' && (dayNumber<1 || dayNumber>366))
            throw new Error('Invalid daily ranking period');
        if(master.isNull() || !objectClass(master).equals(klass('','EventMaster')))
            throw new Error('Unexpected current event master');
        const eventId=master.add(layout.fields.eventMasterId).readS32();
        if(eventId<=0) throw new Error('Invalid current event ID');
        const first=readRows(array), second=readRows(array);
        if(JSON.stringify(first)!==JSON.stringify(second)) throw new Error('Ranking changed during capture');
        if(second.some((entry,i)=>entry.rank!==i+1 || entry.score<0 ||
            (i>0 && entry.score>second[i-1].score))) throw new Error('Invalid TOP20 ranks or scores');
        if(!active(live[0]) || !fieldValue(manager,'_dataList').equals(array))
            throw new Error('The active leaderboard changed during capture');
        if(!presenter.add(layout.fields.rankingPresenterCurrentCell).readPointer().equals(cell) ||
            (rankingName==='デイリーPtランキング' && invoke(objectClass(cell),'get_DayNumber',cell).add(layout.boxedValue).readS32()!==dayNumber))
            throw new Error('The leaderboard period changed during capture');
        if(!active(presenter) || !presenter.add(layout.fields.rankingPresenterMaster).readPointer().equals(master))
            throw new Error('The current event changed during capture');
        return {capturedAt:new Date().toISOString(),entries:second,eventId,rankingName,dayNumber};
    } finally {
        if(!releaseTemporary()) throw new Error('Main-thread cleanup remains pending');
        send({stage:'capture_detach_worker'});
        detachWorker();
        send({stage:'capture_detach_jni'});
        detachJavaThread();
        send({stage:'capture_thread_released'});
    }
}
function captureRanking() {
    try { return {status:'ok',...readRanking()}; }
    catch(error) {
        const pending=pendingCall!==null || pendingRelease!==null || !workerThread.isNull() || jniOwned;
        return {status:'failed',pending,error:error instanceof Error ? error.message.slice(0,256) : 'IL2CPP capture failed'};
    }
}
function closeReader() {
    attachJavaThread();
    rootCount=0;
    if(!releaseTemporary()) return {status:'pending'};
    send({stage:'close_detach_worker'});
    detachWorker();
    send({stage:'close_detach_jni'});
    detachJavaThread();
    return {status:'released'};
}
rpc.exports={capture:captureRanking,close:closeReader};
`;
