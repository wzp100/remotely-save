// Local fork: device-local backups of overwritten config files (see configBackupKey in sync.ts).

type Adapter = {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ size: number } | null>;
  rmdir(path: string, recursive: boolean): Promise<void>;
};

export interface BackupBatch { path: string; time: number; files: number; bytes: number; }

export const BACKUP_KEEP_DAYS = 30;
export const backupRoot = (configDir: string, pluginId: string) => `${configDir}/plugins/${pluginId}/conflict-backups`;

/** Batch folders are named "YYYY-MM-DD HHmmss" (local time); anything else is never touched. */
export function parseBatchTime(name: string): number | undefined {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d)(\d\d)(\d\d)$/.exec(name);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const t = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(t) ? t : undefined;
}

async function measure(adapter: Adapter, folder: string): Promise<{ files: number; bytes: number }> {
  const { files, folders } = await adapter.list(folder);
  let total = { files: files.length, bytes: 0 };
  for (const f of files) total.bytes += (await adapter.stat(f))?.size ?? 0;
  for (const sub of folders) {
    const inner = await measure(adapter, sub);
    total = { files: total.files + inner.files, bytes: total.bytes + inner.bytes };
  }
  return total;
}

export async function listBackups(adapter: Adapter, root: string): Promise<BackupBatch[]> {
  if (!(await adapter.exists(root))) return [];
  const { folders } = await adapter.list(root);
  const batches: BackupBatch[] = [];
  for (const path of folders) {
    const time = parseBatchTime(path.split("/").pop() ?? "");
    if (time === undefined) continue;
    batches.push({ path, time, ...(await measure(adapter, path)) });
  }
  return batches.sort((a, b) => b.time - a.time);
}

/** Removes batches older than maxAgeMs (all batches when maxAgeMs is 0). Returns how many were removed. */
export async function cleanBackups(adapter: Adapter, root: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  if (!(await adapter.exists(root))) return 0;
  const { folders } = await adapter.list(root);
  let removed = 0;
  for (const path of folders) {
    const time = parseBatchTime(path.split("/").pop() ?? "");
    if (time === undefined || now - time < maxAgeMs) continue;
    await adapter.rmdir(path, true);
    removed++;
  }
  return removed;
}
