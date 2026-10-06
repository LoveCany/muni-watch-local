import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Keep a failed owner's marker until the game process changes. A second script
// must not attach over native work whose completion is unknown.
export async function acquireRuntimeOwner(directory: string, gamePid: number) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "il2cpp-reader-owner-" + gamePid + ".json");
  const token = randomUUID();
  let handle;
  try { handle = await open(file, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("This game process already has a runtime reader or unresolved native work");
    throw error;
  }
  try { await handle.writeFile(JSON.stringify({ gamePid, token })); }
  finally { await handle.close(); }
  return async () => {
    const owner: unknown = JSON.parse(await readFile(file, "utf8"));
    if (owner && typeof owner === "object" && "token" in owner && owner.token === token) await unlink(file);
  };
}
