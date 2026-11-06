export async function ensureRuntimeHelper(
  adb: (...args: string[]) => Promise<string>, localPath: string, remotePath: string, digest: string,
) {
  if (!/^[a-f0-9]{64}$/.test(digest) || remotePath !== `/data/local/tmp/muni-unity-invoke-${digest}.so`)
    throw new Error("Invalid content-addressed runtime helper path");
  const existing = await adb("shell", `if [ -f ${remotePath} ]; then sha256sum ${remotePath}; else echo MISSING; fi`);
  if (existing.trim() !== "MISSING") {
    if (existing.trim().split(/\s/)[0] !== digest) throw new Error("Existing runtime helper digest mismatch; file was not replaced");
    return;
  }
  // Replacing an already loaded inode makes its guest mapping appear as (deleted).
  await adb("push", localPath, remotePath);
  await adb("shell", "chmod", "644", remotePath);
  if ((await adb("shell", "sha256sum", remotePath)).trim().split(/\s/)[0] !== digest)
    throw new Error("IL2CPP helper upload verification failed");
}
