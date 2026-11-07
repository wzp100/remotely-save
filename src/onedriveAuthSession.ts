import type { InternalDBs } from "./localdb";

const MAX_AGE_MS = 15 * 60 * 1000;
const sessionKey = (vaultID: string) => `${vaultID}-onedrive-pkce`;

interface PendingAuth {
  verifier: string;
  state: string;
  createdAt: number;
}

export async function saveOneDriveAuthSession(db: InternalDBs, vaultID: string, verifier: string, state: string) {
  await db.simpleKVForMiscTbl.setItem(sessionKey(vaultID), { verifier, state, createdAt: Date.now() } satisfies PendingAuth);
}

export async function consumeOneDriveAuthSession(db: InternalDBs, vaultID: string, state: string | undefined): Promise<string> {
  const key = sessionKey(vaultID);
  const pending = await db.simpleKVForMiscTbl.getItem(key) as PendingAuth | null;
  if (!pending || typeof pending.verifier !== "string" || typeof pending.state !== "string" ||
      typeof pending.createdAt !== "number" || Date.now() - pending.createdAt > MAX_AGE_MS || pending.createdAt > Date.now() + 60000) {
    if (pending) await db.simpleKVForMiscTbl.removeItem(key);
    throw new Error("授权会话已失效，请重新开始。");
  }
  if (!state || state !== pending.state) throw new Error("授权会话校验失败，请重新开始。");
  await db.simpleKVForMiscTbl.removeItem(key);
  return pending.verifier;
}
