// Local fork: basic, history-aware synchronization without a subscription service.
import type { Entity, MixedEntity, RemotelySavePluginSettings, SyncTriggerSourceType } from "./baseTypes";
import type { FakeFs } from "./fsAll";
import type { FakeFsEncrypt } from "./fsEncrypt";
import type { InternalDBs } from "./localdb";
import { clearPrevSyncRecordByVaultAndProfile, getAllPrevSyncRecordsByVaultAndProfile, insertSyncPlanRecordByVault, upsertPrevSyncRecordByVaultAndProfile } from "./localdb";
import { enforceProtection, isSelfPluginFile, modified, planSync, sameMetadata, selfPluginPrefix, type Action, type BasicHistory } from "./syncPlan";
import { prepareSelfPluginPlan } from "./selfPluginSync";
export type SyncPlanType = Record<string, MixedEntity & { operation?: string }>;
export interface SyncSummary { dry: boolean; upload: number; download: number; deleteLocal: number; deleteRemote: number; folders: number; skipped: number; conflicts: number; actions: { path: string; operation: string; conflict?: boolean; copy?: string }[]; }

export function isMissingError(error: unknown): boolean {
  const e=error as {status?:number;statusCode?:number;code?:string;message?:string};
  return e.status===404||e.statusCode===404||e.code==="ENOENT"||/^Request failed, status 404\b/.test(e.message??"")||/\bdoes(?: not|n't) exist(?:! cannot stat for local| cannot run stat)/.test(e.message??"");
}

/** Whether an empty plaintext file reaches the backend as an empty object (encrypted content never is). */
export function remoteAcceptsEmptyFile(remote: FakeFs, rawRemote: FakeFs): boolean {
  const enc = remote as Partial<FakeFsEncrypt>;
  if (typeof enc.isPasswordEmpty === "function") return enc.isPasswordEmpty.call(remote) ? rawRemote.allowEmptyFile() : true;
  return remote.allowEmptyFile();
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

const pad = (n: number) => String(n).padStart(2, "0");
const stampOf = (time: number) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
const sideName = (side: "local" | "remote") => (side === "local" ? "本机" : "云端");

/** Builds "dir/name (冲突 云端 2026-11-17 171500).ext"; avoids characters that Windows, Android and iOS reject. */
export function conflictCopyKey(key: string, side: "local" | "remote", time: number, attempt = 0): string {
  const slash = key.lastIndexOf("/");
  const dir = key.slice(0, slash + 1), name = key.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${dir}${stem} (冲突 ${sideName(side)} ${stampOf(time)}${attempt ? ` ${attempt + 1}` : ""})${ext}`;
}

/**
 * Config files cannot get a sibling copy (Obsidian and plugins would load it), so their losing version
 * goes to this plugin's own folder, which is never synced and never loaded as configuration.
 */
export function configBackupKey(key: string, side: "local" | "remote", time: number, configDir: string): string {
  return `${selfPluginPrefix(configDir)}conflict-backups/${stampOf(time)}/${sideName(side)}/${key.slice(configDir.length + 1)}`;
}

/** Counts what actually happened (after execution) or what is planned (for a preview). */
export function summarize(plan: Action[], dry: boolean): SyncSummary {
  const live = plan.filter(a => a.outcome !== "identical");
  const count = (op: string) => live.filter(a => a.operation === op).length;
  return {
    dry, upload: count("upload"), download: count("download"), deleteLocal: count("delete_local"), deleteRemote: count("delete_remote"),
    folders: count("mkdir_local") + count("mkdir_remote"), skipped: count("skip"), conflicts: live.filter(a => a.conflict).length,
    actions: live.filter(a => !["equal", "skip", "forget"].includes(a.operation))
      .map(a => ({ path: a.key, operation: a.operation, ...(a.conflict ? { conflict: true } : {}), ...(a.conflictCopy ? { copy: a.conflictCopy } : {}) })),
  };
}

export async function executePlan(plan: Action[], local: FakeFs, remote: FakeFs, settings: RemotelySavePluginSettings, save: (history: BasicHistory) => Promise<void>, forget: (key: string) => Promise<void>, progress: (action: Action, done: number) => Promise<void>, configDir = ".obsidian", allowEmpty = remote.allowEmptyFile()) {
  const localDirs = new Set(plan.filter(a => a.key.endsWith("/") && a.local).map(a => a.key));
  const remoteDirs = new Set(plan.filter(a => a.key.endsWith("/") && a.remote).map(a => a.key));
  const folderJobs=new Map<string,Promise<void>>();
  const ensureParents = async (fs: FakeFs, key: string, cache: Set<string>) => {
    const parts = key.split("/"); parts.pop(); let parent = "";
    for (const part of parts) {
      parent+=part+"/";
      if(cache.has(parent))continue;
      const id=(fs===local?"local:":"remote:")+parent;
      let job=folderJobs.get(id);
      if(!job){const target=parent;job=fs.mkdir(target).then(()=>{cache.add(target);});folderJobs.set(id,job);}
      await job;
    }
  };
  const current = async (fs: FakeFs, expected: Entity | undefined, key: string, remoteSide: boolean) => {
    if (!expected) {
      try { await fs.stat(key); }
      catch(error) {
        if(isMissingError(error))return;
        throw error;
      }
      throw new Error(`同步过程中出现新文件，请重试：${key}`);
    }
    const latest = await fs.stat(key);
    if (!sameMetadata(latest, expected, remoteSide)) throw new Error(`同步过程中发生新修改，请重试：${key}`);
  };
  const history = async (key: string) => {
    const [l, r] = await Promise.all([local.stat(key), remote.stat(key)]);
    await save({ ...r, key, size: l.size ?? l.sizeRaw, mtimeCli: l.mtimeCli, prevSyncTime: Date.now(), basicLocal: l, basicRemote: r });
  };
  // Parents before children; removals affect files only, never entire trees.
  // Before one side of a conflict is overwritten, keep the losing content. Notes get a sibling copy that
  // the next sync uploads to every device; config files get a device-local backup in this plugin's folder.
  const backupTime = Date.now();
  const preserveConflict = async (a: Action): Promise<boolean> => {
    const [lc, rc] = await Promise.all([local.readFile(a.key), remote.readFile(a.key)]);
    if (sameBytes(lc, rc)) { await history(a.key); a.outcome = "identical"; return false; }
    const loser: "local" | "remote" = a.operation === "upload" ? "remote" : "local";
    const entity = loser === "local" ? a.local! : a.remote!;
    const content = loser === "local" ? lc : rc;
    if (a.key.startsWith(configDir + "/")) {
      const key = configBackupKey(a.key, loser, backupTime, configDir);
      await ensureParents(local, key, localDirs);
      await local.writeFile(key, content, modified(entity), entity.ctimeCli ?? modified(entity));
      a.conflictCopy = key;
      return true;
    }
    const now = Date.now();
    for (let attempt = 0; ; attempt++) {
      const key = conflictCopyKey(a.key, loser, now, attempt);
      try { await local.stat(key); }
      catch (error) {
        if (!isMissingError(error)) throw error;
        await local.writeFile(key, content, modified(entity), entity.ctimeCli ?? modified(entity));
        a.conflictCopy = key;
        return true;
      }
      if (attempt > 20) throw new Error(`无法为冲突文件生成副本名称：${a.key}`);
    }
  };
  let done = 0;
  const perform=async(a:Action)=>{
    if (a.conflict && a.local && a.remote && (a.operation === "upload" || a.operation === "download")) {
      await current(local, a.local, a.key, false); await current(remote, a.remote, a.key, true);
      if (!(await preserveConflict(a))) { await progress(a, ++done); return; }
    }
    switch (a.operation) {
      case "upload": {
        if ((a.local!.size ?? a.local!.sizeRaw) === 0 && !allowEmpty) {
          if (settings.onedrive?.emptyFile === "error") throw new Error(`远端不支持空文件：${a.key}`);
          break;
        }
        await current(local, a.local, a.key, false); await current(remote, a.remote, a.key, true);
        const content = await local.readFile(a.key);
        await current(local, a.local, a.key, false);
        await ensureParents(remote, a.key, remoteDirs);
        await remote.writeFile(a.key, content, modified(a.local), a.local!.ctimeCli ?? modified(a.local));
        await current(local,a.local,a.key,false);
        await history(a.key); break;
      }
      case "download": {
        await current(remote, a.remote, a.key, true); await current(local, a.local, a.key, false);
        const content = await remote.readFile(a.key);
        await current(remote, a.remote, a.key, true);
        await current(local, a.local, a.key, false);
        await ensureParents(local, a.key, localDirs);
        await local.writeFile(a.key, content, modified(a.remote), a.remote!.ctimeCli ?? modified(a.remote));
        await history(a.key); break;
      }
      case "delete_local":
        await current(local, a.local, a.key, false); await current(remote,undefined,a.key,true); await local.rm(a.key); await forget(a.key); break;
      case "delete_remote":
        await current(remote, a.remote, a.key, true); await current(local,undefined,a.key,false); await remote.rm(a.key); await forget(a.key); break;
      case "mkdir_local": await ensureParents(local, a.key.slice(0,-1), localDirs); await local.mkdir(a.key); localDirs.add(a.key); break;
      case "mkdir_remote": await ensureParents(remote, a.key.slice(0,-1), remoteDirs); await remote.mkdir(a.key); remoteDirs.add(a.key); break;
      case "equal":
        if (a.local && a.remote) await save({ ...a.remote, key:a.key, size:a.local.size ?? a.local.sizeRaw, mtimeCli:a.local.mtimeCli, prevSyncTime:Date.now(), basicLocal:a.local, basicRemote:a.remote });
        break;
      case "forget": await forget(a.key); break;
    }
    await progress(a, ++done);
  };
  const sorted=[...plan].sort((a,b)=>a.key.split("/").length-b.key.split("/").length||a.key.localeCompare(b.key));
  for(const a of sorted.filter(a=>a.key.endsWith("/")))await perform(a);
  const files=sorted.filter(a=>!a.key.endsWith("/") && !isSelfPluginFile(a.key,configDir));let cursor=0,failure:unknown;
  const width=Number.isFinite(settings.concurrency)?Math.min(10,Math.max(1,Math.trunc(settings.concurrency!))):5;
  const worker=async()=>{while(!failure&&cursor<files.length){const a=files[cursor++];try{await perform(a);}catch(error){failure=error;}}};
  await Promise.all(Array.from({length:Math.min(width,files.length)},worker));
  if(failure)throw failure;
  const manifestKey = `${selfPluginPrefix(configDir)}manifest.json`;
  const manifest = plan.find(a => a.key === manifestKey);
  const pluginFiles = sorted.filter(a => isSelfPluginFile(a.key, configDir))
    .sort((a, b) => Number(a.key === manifestKey) - Number(b.key === manifestKey));
  // The manifest is the version marker, so update it only after the other files.
  for (const a of pluginFiles) {
    if (manifest && (a.operation === "upload" || a.operation === "download")) {
      await current(local, manifest.local, manifestKey, false);
      await current(remote, manifest.remote, manifestKey, true);
    }
    await perform(a);
  }
}

export async function syncer(local: FakeFs, _rawRemote: FakeFs, remote: FakeFsEncrypt, _profiler: unknown, db: InternalDBs, source: SyncTriggerSourceType, profile: string, vault: string, configDir: string, settings: RemotelySavePluginSettings, _version: string, _configSaver: () => Promise<unknown>, _protectMessage: unknown, mark: (value: boolean) => Promise<void>, notify: (s: SyncTriggerSourceType, step: number) => Promise<void>, reportError: (s: SyncTriggerSourceType, error: Error) => Promise<void>, ribbon: (s: SyncTriggerSourceType, step: number) => Promise<void>, status: (s: SyncTriggerSourceType, step: number, ok: boolean) => Promise<void>, progress: (s: SyncTriggerSourceType, done: number, total: number, key: string, decision: string) => Promise<void>): Promise<SyncSummary> {
  await mark(true); let ok = false;
  try {
    await ribbon(source,1); await status(source,1,true); await notify(source,1);
    const password = await remote.isPasswordOk();
    if (!password.ok) throw new Error(`同步加密配置不匹配：${password.reason}`);
    const [rawLocal, remoteFiles, previous] = await Promise.all([local.walk(), remote.walk(), getAllPrevSyncRecordsByVaultAndProfile(db,vault,profile)]);
    const gitignore = settings.respectGitignore === false ? undefined : await local.loadGitIgnore?.(rawLocal);
    const localFiles: Entity[] = [];
    for (const entity of rawLocal) localFiles.push(await remote.encryptEntity(entity));
    const plan = planSync(localFiles, remoteFiles, previous, settings, configDir, gitignore);
    await prepareSelfPluginPlan(plan, local, remote, settings, configDir);
    const allowEmpty = remoteAcceptsEmptyFile(remote, _rawRemote);
    for(const action of plan)if(action.operation==="upload"&&(action.local!.size??action.local!.sizeRaw)===0&&!allowEmpty){
      if(settings.onedrive?.emptyFile==="error")throw new Error(`远端不支持空文件：${action.key}`);
      action.operation="skip";
    }
    const report: SyncPlanType = {};
    for (const a of plan) report[a.key] = { key:a.key, local:a.local, remote:a.remote, prevSync:a.previous, operation:a.operation, change:!["equal","skip","forget"].includes(a.operation) };
    await insertSyncPlanRecordByVault(db,report,vault,settings.serviceType);
    let summary = summarize(plan, source === "dry");
    if (source !== "dry") {
      enforceProtection(plan,settings.protectModifyPercentage ?? 50);
      await executePlan(plan,local,remote,settings,record=>upsertPrevSyncRecordByVaultAndProfile(db,vault,profile,record),key=>clearPrevSyncRecordByVaultAndProfile(db,vault,profile,key),async(a,n)=>progress(source,n,plan.length,a.key,a.operation),configDir,allowEmpty);
      summary = summarize(plan, false);
    }
    ok=true; await notify(source,8); return summary;
  } catch (error) {
    await reportError(source,error as Error); throw error;
  } finally {
    // Preview must not advance the last successful transfer time.
    if (source !== "dry" || !ok) await status(source,8,ok);
    await ribbon(source,8); await mark(false); await remote.closeResources();
  }
}
