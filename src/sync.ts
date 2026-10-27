// Local fork: basic, history-aware synchronization without a subscription service.
import type { Entity, MixedEntity, RemotelySavePluginSettings, SyncTriggerSourceType } from "./baseTypes";
import type { FakeFs } from "./fsAll";
import type { FakeFsEncrypt } from "./fsEncrypt";
import type { InternalDBs } from "./localdb";
import { clearPrevSyncRecordByVaultAndProfile, getAllPrevSyncRecordsByVaultAndProfile, insertSyncPlanRecordByVault, upsertPrevSyncRecordByVaultAndProfile } from "./localdb";
import { enforceProtection, modified, planSync, sameMetadata, type Action, type BasicHistory } from "./syncPlan";
export type SyncPlanType = Record<string, MixedEntity & { operation?: string }>;
export interface SyncSummary { dry: boolean; upload: number; download: number; deleteLocal: number; deleteRemote: number; folders: number; skipped: number; conflicts: number; actions: { path: string; operation: string }[]; }

export function isMissingError(error: unknown): boolean {
  const e=error as {status?:number;statusCode?:number;code?:string;message?:string};
  return e.status===404||e.statusCode===404||e.code==="ENOENT"||/^Request failed, status 404\b/.test(e.message??"")||/\bdoes(?: not|n't) exist(?:! cannot stat for local| cannot run stat)/.test(e.message??"");
}

export async function executePlan(plan: Action[], local: FakeFs, remote: FakeFs, settings: RemotelySavePluginSettings, save: (history: BasicHistory) => Promise<void>, forget: (key: string) => Promise<void>, progress: (action: Action, done: number) => Promise<void>) {
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
  let done = 0;
  const perform=async(a:Action)=>{
    switch (a.operation) {
      case "upload": {
        if ((a.local!.size ?? a.local!.sizeRaw) === 0 && !remote.allowEmptyFile()) {
          if (settings.onedrive?.emptyFile === "error") throw new Error(`远端不支持空文件：${a.key}`);
          return;
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
  const files=sorted.filter(a=>!a.key.endsWith("/"));let cursor=0,failure:unknown;
  const width=Number.isFinite(settings.concurrency)?Math.min(10,Math.max(1,Math.trunc(settings.concurrency!))):5;
  const worker=async()=>{while(!failure&&cursor<files.length){const a=files[cursor++];try{await perform(a);}catch(error){failure=error;}}};
  await Promise.all(Array.from({length:Math.min(width,files.length)},worker));
  if(failure)throw failure;
}

export async function syncer(local: FakeFs, _rawRemote: FakeFs, remote: FakeFsEncrypt, _profiler: unknown, db: InternalDBs, source: SyncTriggerSourceType, profile: string, vault: string, configDir: string, settings: RemotelySavePluginSettings, _version: string, _configSaver: () => Promise<unknown>, _protectMessage: unknown, mark: (value: boolean) => Promise<void>, notify: (s: SyncTriggerSourceType, step: number) => Promise<void>, reportError: (s: SyncTriggerSourceType, error: Error) => Promise<void>, ribbon: (s: SyncTriggerSourceType, step: number) => Promise<void>, status: (s: SyncTriggerSourceType, step: number, ok: boolean) => Promise<void>, progress: (s: SyncTriggerSourceType, done: number, total: number, key: string, decision: string) => Promise<void>): Promise<SyncSummary> {
  await mark(true); let ok = false;
  try {
    await ribbon(source,1); await status(source,1,true); await notify(source,1);
    const password = await remote.isPasswordOk();
    if (!password.ok) throw new Error(`同步加密配置不匹配：${password.reason}`);
    const [rawLocal, remoteFiles, previous] = await Promise.all([local.walk(), remote.walk(), getAllPrevSyncRecordsByVaultAndProfile(db,vault,profile)]);
    const localFiles: Entity[] = [];
    for (const entity of rawLocal) localFiles.push(await remote.encryptEntity(entity));
    const plan = planSync(localFiles, remoteFiles, previous, settings, configDir);
    for(const action of plan)if(action.operation==="upload"&&(action.local!.size??action.local!.sizeRaw)===0&&!remote.allowEmptyFile()){
      if(settings.onedrive?.emptyFile==="error")throw new Error(`远端不支持空文件：${action.key}`);
      action.operation="skip";
    }
    const report: SyncPlanType = {};
    for (const a of plan) report[a.key] = { key:a.key, local:a.local, remote:a.remote, prevSync:a.previous, operation:a.operation, change:!["equal","skip","forget"].includes(a.operation) };
    await insertSyncPlanRecordByVault(db,report,vault,settings.serviceType);
    const count = (op: string) => plan.filter(a => a.operation === op).length;
    const summary: SyncSummary = { dry:source === "dry", upload:count("upload"), download:count("download"), deleteLocal:count("delete_local"), deleteRemote:count("delete_remote"), folders:count("mkdir_local")+count("mkdir_remote"), skipped:count("skip"), conflicts:plan.filter(a=>a.conflict).length, actions:plan.filter(a=>!["equal","skip","forget"].includes(a.operation)).map(a=>({path:a.key,operation:a.operation})) };
    if (source !== "dry") {
      enforceProtection(plan,settings.protectModifyPercentage ?? 50);
      await executePlan(plan,local,remote,settings,record=>upsertPrevSyncRecordByVaultAndProfile(db,vault,profile,record),key=>clearPrevSyncRecordByVaultAndProfile(db,vault,profile,key),async(a,n)=>progress(source,n,plan.length,a.key,a.operation));
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
