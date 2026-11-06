export async function withOperationDeadline<T>(
  operation: () => Promise<T>, onTimeout: () => void, timeoutMs = 30000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try { onTimeout(); }
      catch (error) { reject(error); return; }
      reject(new Error("IL2CPP operation timed out; resources retained for recovery"));
    }, timeoutMs);
  });
  // Cancellation may not settle an RPC blocked in native code; bound the host wait independently.
  try { return await Promise.race([Promise.resolve().then(operation), expired]); }
  finally { clearTimeout(timer); }
}
