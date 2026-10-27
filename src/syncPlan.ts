// Local fork: independently implemented basic sync planning (Apache-2.0).
import type { Entity, RemotelySavePluginSettings } from "./baseTypes";
export type Operation = "upload" | "download" | "delete_local" | "delete_remote" | "mkdir_local" | "mkdir_remote" | "equal" | "forget" | "skip";
export interface BasicHistory extends Entity { basicLocal?: Entity; basicRemote?: Entity; }
export interface Action { key: string; operation: Operation; local?: Entity; remote?: Entity; previous?: BasicHistory; conflict?: boolean; }
export const modified = (entity?: Entity) => entity?.mtimeCli ?? entity?.mtimeSvr ?? 0;
const size = (entity?: Entity) => entity?.size ?? entity?.sizeRaw;
export function sameMetadata(a: Entity, b: Entity, remote = false): boolean {
  const aSize = remote ? a.sizeEnc ?? a.sizeRaw : size(a);
  const bSize = remote ? b.sizeEnc ?? b.sizeRaw : size(b);
  if (aSize !== bSize) return false;
  if (remote && a.etag && b.etag) return a.etag === b.etag;
  return modified(a) === modified(b);
}
export function sameSides(local: Entity, remote: Entity): boolean {
  return (local.sizeEnc ?? local.size ?? local.sizeRaw) === (remote.sizeEnc ?? remote.sizeRaw)
    && Math.abs(modified(local) - modified(remote)) < 1000;
}
export function includePath(key: string, settings: RemotelySavePluginSettings, configDir: string): boolean {
  if (!key || key.startsWith("/") || key.includes("\\") || key.split("/").some(p => p === "." || p === "..")) throw new Error(`无效的同步路径：${key}`);
  const parts = key.split("/").filter(Boolean);
  const prohibited = new Set([".git", ".svn", ".github", ".trash", "node_modules", ".DS_Store", "desktop.ini", "Thumbs.db"]);
  if (parts.some(p => prohibited.has(p)) || key.startsWith("_debug_remotely_save/") || key.startsWith("_remotely-save-metadata-on-remote.")) return false;
  if (key === configDir + "/" || key.startsWith(configDir + "/")) {
    if(key===`${configDir}/workspace.json`||key.startsWith(`${configDir}/workspace/`))return false;
    if (key.startsWith(`${configDir}/plugins/remotely-save/`) || key.startsWith(`${configDir}/plugins/remotely-save-console/`)) return false;
    if (!settings.syncConfigDir && !(settings.syncBookmarks && key === `${configDir}/bookmarks.json`)) return false;
  } else if (parts.some(p => p.startsWith(".") || (!settings.syncUnderscoreItems && p.startsWith("_")))) return false;
  if ((settings.ignorePaths ?? []).some(pattern => new RegExp(pattern).test(key))) return false;
  if ((settings.onlyAllowPaths ?? []).length && !(settings.onlyAllowPaths ?? []).some(pattern => new RegExp(pattern).test(key))) return false;
  return true;
}
export function planSync(localFiles: Entity[], remoteFiles: Entity[], history: BasicHistory[], settings: RemotelySavePluginSettings, configDir = ".obsidian"): Action[] {
  // Validate user regexes before a plan can cause any writes.
  for (const pattern of [...settings.ignorePaths ?? [], ...settings.onlyAllowPaths ?? []]) new RegExp(pattern);
  const index = <T extends Entity>(files: T[]) => {
    const map = new Map<string, T>();
    for (const f of files) {
      const key = f.key ?? f.keyRaw;
      if (!includePath(key, settings, configDir)) continue;
      if (map.has(key)) throw new Error(`重复的同步路径：${key}`);
      map.set(key, f);
    }
    return map;
  };
  const local = index(localFiles), remote = index(remoteFiles), previous = index(history);
  const direction = settings.syncDirection ?? "bidirectional";
  const pushOnly = direction === "incremental_push_only" || direction === "incremental_push_and_delete_only";
  const pullOnly = direction === "incremental_pull_only" || direction === "incremental_pull_and_delete_only";
  const allowPushDelete = direction === "bidirectional" || direction === "incremental_push_and_delete_only";
  const allowPullDelete = direction === "bidirectional" || direction === "incremental_pull_and_delete_only";
  const result: Action[] = [];
  for (const key of [...new Set([...local.keys(), ...remote.keys(), ...previous.keys()])].sort()) {
    const l = local.get(key), r = remote.get(key), h = previous.get(key);
    const action: Action = { key, local: l, remote: r, previous: h, operation: "skip" };
    if (key.endsWith("/")) {
      // Never recursively delete folders: they can contain excluded files.
      action.operation = l && !r && !pullOnly ? "mkdir_remote" : r && !l && !pushOnly ? "mkdir_local" : "skip";
    } else if (!l && !r) action.operation = "forget";
    else if ((settings.skipSizeLargerThan ?? -1) > 0 && Math.max(l?.size ?? l?.sizeRaw ?? 0, r?.sizeEnc ?? r?.sizeRaw ?? 0) > settings.skipSizeLargerThan!) action.operation = "skip";
    else if (l && r) {
      if (sameSides(l, r)) action.operation = "equal";
      else if (pushOnly) action.operation = "upload";
      else if (pullOnly) action.operation = "download";
      else {
        const localChanged = !h || !sameMetadata(l, h.basicLocal ?? h);
        const remoteChanged = !h || !sameMetadata(r, h.basicRemote ?? h, true);
        if (!localChanged && remoteChanged) action.operation = "download";
        else if (localChanged && !remoteChanged) action.operation = "upload";
        else if (!localChanged && !remoteChanged) action.operation = "equal";
        else {
          action.conflict = true;
          if (settings.conflictAction !== "keep_newer" && settings.conflictAction !== "keep_larger" && settings.conflictAction !== undefined) throw new Error("请选择保留较新或较大文件的冲突策略。");
          const chooseLocal = settings.conflictAction === "keep_larger" ? (l.sizeEnc ?? l.size ?? l.sizeRaw) >= (r.sizeEnc ?? r.sizeRaw) : modified(l) >= modified(r);
          action.operation = chooseLocal ? "upload" : "download";
        }
      }
    } else if (l) {
      if (h && sameMetadata(l, h.basicLocal ?? h) && allowPullDelete) action.operation = "delete_local";
      else if (!pullOnly) action.operation = "upload";
    } else if (r) {
      if (h && sameMetadata(r, h.basicRemote ?? h, true) && allowPushDelete) action.operation = "delete_remote";
      else if (!pushOnly) action.operation = "download";
    }
    result.push(action);
  }
  return result;
}
export function enforceProtection(plan: Action[], percentage: number): void {
  if (percentage < 0 || percentage >= 100) return;
  const files = plan.filter(a => !a.key.endsWith("/") && (a.local || a.remote));
  const changes = files.filter(a => a.operation === "delete_local" || a.operation === "delete_remote" || (a.operation === "upload" && a.remote) || (a.operation === "download" && a.local)).length;
  if (files.length && changes * 100 / files.length > percentage) throw new Error(`修改保护已拦截：${changes}/${files.length} 个文件将被覆盖或删除，超过 ${percentage}%。请先查看同步预览。`);
}
