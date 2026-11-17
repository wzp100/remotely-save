// Local fork: incremental OneDrive listing. Pure functions, so they can be tested without Obsidian.
//
// A full listing pages through every item under the sync folder. Microsoft Graph also returns a
// deltaLink that yields only what changed since. Changed items do not reliably carry their full path
// (children of a renamed folder are not even reported), so paths are rebuilt from the id -> parent id
// chain of a cached snapshot. Anything that does not resolve cleanly makes the caller fall back to a
// full listing.
import type { DriveItem } from "@microsoft/microsoft-graph-types";
import type { Entity } from "./baseTypes";

export interface SlimItem {
  id: string; name: string; parentId?: string; folder: boolean;
  size: number; mtime: string; ctime?: string; eTag?: string;
}

export interface DeltaCache {
  v: 1;
  /** Account + app + sync folder; a different scope never reuses this snapshot. */
  scope: string;
  rootId: string;
  deltaLink: string;
  fullAt: number;
  incrementalRuns: number;
  items: SlimItem[];
}

export interface DeltaStore {
  load(scope: string): Promise<DeltaCache | undefined>;
  save(cache: DeltaCache): Promise<void>;
  clear(): Promise<void>;
}

/** A full listing is forced at least this often, as a safety net against drift. */
export const FULL_LISTING_EVERY_MS = 24 * 3600 * 1000;

export function slimOf(x: DriveItem): SlimItem | undefined {
  const mtime = x.fileSystemInfo?.lastModifiedDateTime;
  if (!x.id || !x.name || !mtime) return undefined;
  return {
    id: x.id, name: x.name, parentId: x.parentReference?.id ?? undefined, folder: "folder" in x && !!x.folder,
    size: x.size ?? 0, mtime, ctime: x.fileSystemInfo?.createdDateTime ?? undefined, eTag: x.eTag ?? undefined,
  };
}

/** Mirrors fromDriveItemToEntity field by field; the full listing verifies that they agree. */
export function slimToEntity(it: SlimItem, key: string): Entity {
  const mtime = Date.parse(it.mtime);
  return {
    key, keyRaw: key, mtimeSvr: mtime, mtimeCli: mtime, ctimeCli: Date.parse(it.ctime ?? it.mtime),
    size: it.folder ? 0 : it.size, sizeRaw: it.folder ? 0 : it.size, etag: it.eTag ?? undefined, synthesizedFile: false,
  };
}

/** Rebuilds every path from the parent chain; undefined if any item does not lead back to the root. */
export function entitiesFromSlim(items: Map<string, SlimItem>, rootId: string): Entity[] | undefined {
  const keys = new Map<string, string>([[rootId, ""]]);
  const resolve = (id: string): string | undefined => {
    const chain: SlimItem[] = [];
    let cur: string | undefined = id;
    while (cur !== undefined && !keys.has(cur)) {
      const it = items.get(cur);
      if (!it || chain.length > 512) return undefined;
      chain.push(it);
      cur = it.parentId;
    }
    if (cur === undefined) return undefined;
    let key = keys.get(cur)!;
    // An already resolved ancestor must be the root or a folder, never a file.
    if (chain.length && cur !== rootId && !key.endsWith("/")) return undefined;
    for (const it of chain.reverse()) {
      if (!it.folder && it !== chain[chain.length - 1]) return undefined; // a file cannot be a parent
      key = `${key}${it.name}${it.folder ? "/" : ""}`;
      keys.set(it.id, key);
    }
    return key;
  };
  const out: Entity[] = [];
  for (const it of items.values()) {
    if (it.id === rootId) continue;
    const key = resolve(it.id);
    if (key === undefined) return undefined;
    out.push(slimToEntity(it, key));
  }
  return out;
}

/** Applies one delta page sequence to a snapshot. undefined means "cannot trust this, list everything". */
export function applyDelta(cache: DeltaCache, changes: DriveItem[]): Map<string, SlimItem> | undefined {
  const items = new Map(cache.items.map((i) => [i.id, i] as const));
  for (const x of changes) {
    if (!x.id) return undefined;
    if (x.deleted) {
      if (x.id === cache.rootId) return undefined;
      items.delete(x.id);
      continue;
    }
    const slim = slimOf(x);
    if (x.id === cache.rootId) { if (slim) items.set(x.id, slim); continue; }
    if (!slim || !slim.parentId) return undefined;
    items.set(x.id, slim);
  }
  return items;
}

const canonical = (entities: Entity[]) =>
  JSON.stringify([...entities].sort((a, b) => (a.key! < b.key! ? -1 : a.key! > b.key! ? 1 : 0)));

/** True when the id-chain reconstruction reproduces the path-based listing exactly. */
export function sameListing(a: Entity[], b: Entity[]): boolean {
  return a.length === b.length && canonical(a) === canonical(b);
}
