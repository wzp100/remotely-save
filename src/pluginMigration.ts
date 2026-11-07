const LEGACY_ID = "remotely-save";

// Optional one-time rule for using the old client to fetch only this plugin.
export const BOOTSTRAP_ONLY_PROGRAMS_RULE = "^(?!\\.obsidian/(?:plugins/(?:remotely-save-local/(?:main\\.js|styles\\.css|manifest\\.json)?)?)?$)";
export const BOOTSTRAP_ALLOW_PROGRAMS_RULE = "^\\.obsidian/(?:plugins/(?:remotely-save-local/(?:main\\.js|styles\\.css|manifest\\.json)?)?)?$";
export const BOOTSTRAP_CONFIG_WAS_OFF_RULE = "^(?!)rs-local-config-was-off$";

/** Old and local plugins share OAuth callback URIs and must not run together. */
export function legacyPluginEnabled(app: unknown): boolean {
  const plugins = (app as { plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, unknown> } }).plugins;
  return !!plugins?.enabledPlugins?.has(LEGACY_ID) || !!plugins?.plugins?.[LEGACY_ID];
}

/** Read a device's old settings locally only when the new plugin has none. */
export async function loadLocalOrLegacySettings(
  current: unknown,
  adapter: { exists(path: string): Promise<boolean>; read(path: string): Promise<string> },
  configDir: string
): Promise<{ data: unknown; legacy: boolean; localFork: boolean }> {
  if (current !== null && current !== undefined) return { data: current, legacy: false, localFork: false };
  const legacyDir = `${configDir}/plugins/${LEGACY_ID}`;
  const dataPath = `${legacyDir}/data.json`;
  if (!await adapter.exists(dataPath)) return { data: current, legacy: false, localFork: false };
  // A failed or invalid read must stop migration instead of replacing credentials with defaults.
  const data = JSON.parse(await adapter.read(dataPath));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("旧版设置文件无效，已停止迁移。");
  let localFork = false;
  try {
    const manifest = JSON.parse(await adapter.read(`${legacyDir}/manifest.json`));
    localFork = manifest.id === LEGACY_ID && manifest.name === "Remotely Save 本地版";
  } catch {
    // Unknown legacy sync history is isolated rather than used to infer deletions.
  }
  return { data, legacy: true, localFork };
}
