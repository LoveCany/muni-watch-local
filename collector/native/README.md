# Unity invocation helper

This AArch64 ELF contains the regular JNI dispatcher and a UnitySynchronizationContext callback used by the build-guarded ranking reader. The normal JNI path is required for MuMu's Houdini bridge; calling guest IL2CPP exports as host x64 functions is invalid.

- `jni_dispatch.S` exports `D4DJJniDispatch` at ELF offset `0x1200`. It forwards a frame's function pointer and up to four integer/pointer arguments through the regular JNI bridge.
- `unity_main_invoke.S` exports `D4DJUnityMainInvoke` at ELF offset `0x1000`. The reader installs this address as a `SendOrPostCallback` and posts managed invocations to Unity's main thread; the callback stores the result, GC handle, exception and completion status.

`build_helper.py` assembles both sources into `unity_invoke.so`. The runtime resolves the dispatcher by its export name and the main-thread callback by its fixed ELF offset. Renaming these sources does not change their calling convention or task-state layout.

Rebuild from this directory's assembly using the pinned assembler:

```powershell
uv run --no-project --with keystone-engine==0.9.2 python collector/native/build_helper.py
```

The runtime copies managed method metadata into a rooted callback descriptor and uses it only on Unity's main thread. Returned references are rooted before the controller reads them. This APK uses pointer-sized GC handles, unlike the uint32 handles in standard IL2CPP headers: its allocator returns a slot address, and its free implementation masks that address to an 8 KiB page. Never truncate handles. The native callback stores the eight-byte handle at state offset 56 and the completion flag at offset 96. Temporary handles are retired only after each free returns. Failed or timed-out native calls must not be retried through another injected owner in the same unresolved process.
