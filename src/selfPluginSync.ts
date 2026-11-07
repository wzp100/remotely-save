import type { RemotelySavePluginSettings } from "./baseTypes";
import type { FakeFs } from "./fsAll";
import {
  SELF_PLUGIN_FILES,
  isSelfPluginFile,
  sameMetadata,
  selfPluginPrefix,
  type Action,
} from "./syncPlan";

type Manifest = { id: string; name: string; version: string };
type Side = "local" | "remote";

function parseManifest(data: ArrayBuffer): Manifest {
  let value: Manifest;
  try {
    value = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new Error("Remotely Save 的插件清单无法读取，已停止同步插件程序文件。");
  }
  if (value.id !== "remotely-save" || typeof value.name !== "string" ||
      typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) {
    throw new Error("Remotely Save 的插件清单无效，已停止同步插件程序文件。");
  }
  return value;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

async function filesMatch(actions: Action[], local: FakeFs, remote: FakeFs): Promise<boolean> {
  for (const action of actions) {
    if (!action.local || !action.remote) return false;
    const [a, b] = await Promise.all([local.readFile(action.key), remote.readFile(action.key)]);
    if (a.byteLength !== b.byteLength) return false;
    const left = new Uint8Array(a), right = new Uint8Array(b);
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Decide on one source for the whole plugin, never for its per-device settings. */
export async function prepareSelfPluginPlan(
  plan: Action[], local: FakeFs, remote: FakeFs,
  settings: RemotelySavePluginSettings, configDir: string
): Promise<void> {
  const actions = plan.filter(a => isSelfPluginFile(a.key, configDir));
  if (actions.length === 0) return;
  const prefix = selfPluginPrefix(configDir);
  if (actions.length !== SELF_PLUGIN_FILES.length) {
    throw new Error("插件程序文件不完整或被同步规则部分排除，请检查同步配置。");
  }
  const sizeLimit = settings.skipSizeLargerThan ?? -1;
  if (sizeLimit > 0 && actions.some(a => Math.max(a.local?.size ?? a.local?.sizeRaw ?? 0, a.remote?.sizeEnc ?? a.remote?.sizeRaw ?? 0) > sizeLimit)) {
    for (const action of actions) action.operation = "skip";
    return;
  }
  const manifest = actions.find(a => a.key === `${prefix}manifest.json`)!;
  if (!manifest.local) throw new Error("本机插件清单不存在，已停止同步插件程序文件。");
  const localManifest = parseManifest(await local.readFile(manifest.key));
  let source: Side | "equal";
  if (!manifest.remote) {
    if (actions.some(a => a.remote)) throw new Error("云端插件清单不存在，无法安全判断程序版本。");
    source = "local";
  } else {
    const remoteManifest = parseManifest(await remote.readFile(manifest.key));
    const comparison = compareVersions(localManifest.version, remoteManifest.version);
    if (remoteManifest.name !== localManifest.name) {
      if (comparison < 0) throw new Error("云端是不同的较新插件版本，请先确认后再同步程序文件。");
      source = "local";
    } else if (comparison !== 0) {
      source = comparison > 0 ? "local" : "remote";
    } else if (actions.some(a => !a.local || !a.remote)) {
      if (actions.every(a => !!a.local)) source = "local";
      else if (actions.every(a => !!a.remote)) source = "remote";
      else throw new Error("两端的插件程序文件均不完整，无法安全同步。");
    } else {
      const completeHistory = actions.every(a => !!a.previous?.basicLocal && !!a.previous?.basicRemote);
      const localChanged = completeHistory && actions.some(a => !sameMetadata(a.local!, a.previous!.basicLocal!));
      const remoteChanged = completeHistory && actions.some(a => !sameMetadata(a.remote!, a.previous!.basicRemote!, true));
      if (completeHistory && !localChanged && !remoteChanged) source = "equal";
      else if (completeHistory && localChanged !== remoteChanged) source = localChanged ? "local" : "remote";
      else if (await filesMatch(actions, local, remote)) source = "equal";
      else throw new Error("两端的同版本插件程序不一致，请先确认使用哪一份，已停止覆盖。");
    }
  }

  if (source !== "equal" && actions.some(a => !a[source])) {
    throw new Error(`${source === "local" ? "本机" : "云端"}插件程序文件不完整，已停止覆盖。`);
  }
  const direction = settings.syncDirection ?? "bidirectional";
  const allowed = source === "equal" ||
    (source === "local" ? !direction.startsWith("incremental_pull") : !direction.startsWith("incremental_push"));
  for (const action of actions) {
    action.operation = !allowed ? "skip" : source === "equal" ? "equal" : source === "local" ? "upload" : "download";
    action.conflict = false;
  }
}
