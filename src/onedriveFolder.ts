import { nanoid } from "nanoid";
import type { OnedriveConfig, RemotelySavePluginSettings } from "./baseTypes";

export function changeOneDriveFolder(config: OnedriveConfig, input: string): OnedriveConfig {
  const folder = input.trim();
  if (folder === "." || folder === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(folder) || folder.endsWith(".")) {
    throw new Error("远程目录只能填写一个有效的 OneDrive 文件夹名称。");
  }
  if ((config.remoteBaseDir ?? "") === folder) return config;
  return { ...config, remoteBaseDir: folder, deltaLink: "", syncProfileID: nanoid() };
}

export function getSyncProfileID(settings: RemotelySavePluginSettings): string {
  if (!settings.serviceType) throw new Error("unknown serviceType in the setting!");
  const id = settings.serviceType === "onedrive" ? settings.onedrive.syncProfileID : undefined;
  if (id && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("OneDrive 同步历史标识无效。");
  return id ? `onedrive-folder-${id}` : `${settings.serviceType}-default-1`;
}
