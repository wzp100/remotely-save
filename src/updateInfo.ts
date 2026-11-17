// Local fork: version and update information for the settings page.
import { requestUrl } from "obsidian";

export const REPO = "wzp100/remotely-save";
export const REPO_URL = `https://github.com/${REPO}`;
export const BRAT_ID = "obsidian42-brat";
export const BRAT_UPDATE_COMMAND = "obsidian42-brat:checkForUpdatesAndUpdate";

export interface ReleaseInfo { version: string; url: string; publishedAt?: number; notes: string; }
export interface UpdateCheck { at: number; latest?: ReleaseInfo; error?: string; cloudVersion?: string; cloudError?: string; cloudDeferred?: boolean; }

/** Numeric x.y.z comparison; non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const x = a.replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
  const y = b.replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Latest published GitHub release (the same source BRAT installs from). */
export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const res = await requestUrl({
    url: `https://api.github.com/repos/${REPO}/releases/latest`,
    headers: { Accept: "application/vnd.github+json" },
    throw: false,
  });
  if (res.status === 404) throw new Error("GitHub 上还没有发布版本");
  if (res.status === 403 || res.status === 429) throw new Error("GitHub 访问过于频繁，请稍后再试");
  if (res.status < 200 || res.status >= 300) throw new Error(`GitHub 返回 HTTP ${res.status}`);
  const json = res.json as { tag_name?: string; html_url?: string; published_at?: string; body?: string };
  if (!json.tag_name) throw new Error("GitHub 返回的发布信息不完整");
  return {
    version: json.tag_name.replace(/^v/, ""),
    url: json.html_url ?? `${REPO_URL}/releases`,
    publishedAt: json.published_at ? Date.parse(json.published_at) : undefined,
    notes: (json.body ?? "").replace(/\n*🤖 Generated with[^\n]*$/u, "").trim(),
  };
}

/** Session cache, shared across settings re-renders; GitHub allows 60 anonymous requests per hour. */
let cache: UpdateCheck | undefined;
export const cachedUpdateCheck = () => cache;
export const storeUpdateCheck = (value: UpdateCheck) => { cache = value; };
export const UPDATE_CHECK_TTL = 6 * 3600 * 1000;
