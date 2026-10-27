import type { RemotelySavePluginSettings } from "./baseTypes";
// Local fork: retain all basic settings and tokens; discard retired account data.
export function stripPaidConfig<T extends RemotelySavePluginSettings>(settings:T):T {
  const result={...settings} as T & Record<string,unknown>;
  for(const key of ["pro","onedrivefull","googledrive","box","pcloud","yandexdisk","koofr","azureblobstorage"])delete result[key];
  if(!["onedrive","s3","dropbox","webdav","webdis"].includes(result.serviceType))throw new Error("当前服务已移除，请恢复备份并迁移到基础同步服务。");
  return result;
}
