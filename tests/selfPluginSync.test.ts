import { strict as assert } from "node:assert";
import { moment } from "obsidian";
import type { Entity, RemotelySavePluginSettings } from "../src/baseTypes";
import { executePlan, syncer } from "../src/sync";
import { prepareSelfPluginPlan } from "../src/selfPluginSync";
import { includePath, planSync, type BasicHistory } from "../src/syncPlan";

const root = ".obsidian/plugins/remotely-save/";
const names = ["main.js", "styles.css", "manifest.json"];
const config = (extra: Record<string, unknown> = {}) => ({
  serviceType: "onedrive", syncConfigDir: true, syncDirection: "bidirectional",
  conflictAction: "keep_newer", concurrency: 5, ...extra,
} as RemotelySavePluginSettings);
const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

class MemoryFs {
  kind = "memory";
  files = new Map<string, { entity: Entity; body: ArrayBuffer }>();
  writes: string[] = [];
  removed: string[] = [];
  put(key: string, content: string, time = 1000) {
    const body = bytes(content);
    this.files.set(key, { entity: { key, keyRaw: key, size: body.byteLength, sizeRaw: body.byteLength, mtimeCli: time, mtimeSvr: time }, body });
    return this;
  }
  async walk() { return [...this.files.values()].map(f => ({ ...f.entity })); }
  async stat(key: string) {
    const f = this.files.get(key);
    if (!f) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    return { ...f.entity };
  }
  async readFile(key: string) {
    if (key.endsWith("data.json")) throw new Error("settings must not be read");
    const f = this.files.get(key);
    if (!f) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    return f.body.slice(0);
  }
  async writeFile(key: string, body: ArrayBuffer, time: number) {
    if (key.endsWith("data.json")) throw new Error("settings must not be overwritten");
    this.writes.push(key);
    this.files.set(key, { entity: { key, keyRaw: key, size: body.byteLength, sizeRaw: body.byteLength, mtimeCli: time, mtimeSvr: time }, body: body.slice(0) });
    return this.stat(key);
  }
  async mkdir(key: string) { this.put(key, ""); return this.stat(key); }
  async rm(key: string) { this.removed.push(key); this.files.delete(key); }
  allowEmptyFile() { return true; }
  async isPasswordOk() { return { ok: true }; }
  async encryptEntity(entity: Entity) { return { ...entity, sizeEnc: entity.sizeRaw }; }
  async closeResources() {}
  content(key: string) { return new TextDecoder().decode(this.files.get(key)!.body); }
}

function bundle(version: string, name: string, time: number, suffix = version) {
  const fs = new MemoryFs();
  for (const dir of [".obsidian/", ".obsidian/plugins/", root]) fs.put(dir, "", time);
  fs.put(root + "manifest.json", JSON.stringify({ id: "remotely-save", name, version }), time);
  fs.put(root + "main.js", `code-${suffix}`, time);
  fs.put(root + "styles.css", `styles-${suffix}`, time);
  fs.put(root + "data.json", `private-${suffix}`, time);
  fs.put(root + "other-private.txt", `other-${suffix}`, time);
  return fs;
}

async function prepare(local: MemoryFs, remote: MemoryFs, history: BasicHistory[] = [], settings = config()) {
  const plan = planSync(await local.walk(), await remote.walk(), history, settings);
  await prepareSelfPluginPlan(plan, local as any, remote as any, settings, ".obsidian");
  return plan;
}

async function run(plan: Awaited<ReturnType<typeof prepare>>, local: MemoryFs, remote: MemoryFs, settings = config()) {
  const history: BasicHistory[] = [];
  await executePlan(plan, local as any, remote as any, settings, async item => { history.push(item); }, async () => {}, async () => {});
  return history;
}

describe("Remotely Save program file synchronization", () => {
  it("includes only its three program files when configuration sync is enabled", () => {
    for (const name of names) assert.equal(includePath(root + name, config(), ".obsidian"), true);
    for (const name of ["data.json", "other-private.txt", "nested/main.js", "Data.json"]) {
      assert.equal(includePath(root + name, config(), ".obsidian"), false);
    }
    assert.equal(includePath(root + "main.js", config({ syncConfigDir: false }), ".obsidian"), false);
    assert.equal(includePath(".obsidian/plugins/remotely-save-console/main.js", config(), ".obsidian"), false);
  });

  it("replaces an older cloud fork as a bundle without touching either data file", async () => {
    const local = bundle("0.6.2", "Remotely Save 本地版", 1000, "new");
    const remote = bundle("0.5.26", "Remotely Save (Fork)", 9000, "old");
    const plan = await prepare(local, remote);
    assert.deepEqual(plan.filter(a => a.key.startsWith(root) && !a.key.endsWith("/")).map(a => a.operation), ["upload", "upload", "upload"]);
    await run(plan, local, remote);
    assert.deepEqual(remote.writes, names.map(n => root + n));
    assert.equal(remote.content(root + "main.js"), "code-new");
    assert.equal(local.content(root + "data.json"), "private-new");
    assert.equal(remote.content(root + "data.json"), "private-old");
    assert.deepEqual(local.removed.concat(remote.removed), []);
  });

  it("downloads a newer local fork as a bundle without importing cloud settings", async () => {
    const local = bundle("0.6.2", "Remotely Save 本地版", 9000, "old");
    const remote = bundle("0.6.3", "Remotely Save 本地版", 1000, "new");
    const plan = await prepare(local, remote);
    await run(plan, local, remote);
    assert.deepEqual(local.writes, names.map(n => root + n));
    assert.equal(local.content(root + "main.js"), "code-new");
    assert.equal(local.content(root + "data.json"), "private-old");
    assert.equal(remote.content(root + "data.json"), "private-new");
  });

  it("establishes history for identical same-version files without copying them", async () => {
    const local = bundle("0.6.2", "Remotely Save 本地版", 1000);
    const remote = bundle("0.6.2", "Remotely Save 本地版", 9000);
    const plan = await prepare(local, remote);
    const history = await run(plan, local, remote);
    assert.equal(history.filter(h => names.some(n => h.key === root + n)).length, 3);
    assert.deepEqual(local.writes.concat(remote.writes), []);
  });

  it("rejects ambiguous same-version differences and unknown newer forks", async () => {
    await assert.rejects(() => prepare(bundle("0.6.2", "Remotely Save 本地版", 1000, "a"), bundle("0.6.2", "Remotely Save 本地版", 1000, "b")), /同版本插件程序不一致/);
    await assert.rejects(() => prepare(bundle("0.6.2", "Remotely Save 本地版", 1000), bundle("0.7.0", "Another fork", 1000)), /不同的较新插件版本/);
  });

  it("restores a missing program file instead of propagating its deletion", async () => {
    const local = bundle("0.6.2", "Remotely Save 本地版", 1000);
    const remote = bundle("0.6.2", "Remotely Save 本地版", 1000);
    remote.files.delete(root + "styles.css");
    const plan = await prepare(local, remote);
    await run(plan, local, remote);
    assert.equal(remote.content(root + "styles.css"), "styles-0.6.2");
    assert.deepEqual(local.removed.concat(remote.removed), []);
  });

  it("respects the configured direction and refuses a stale target manifest", async () => {
    const local = bundle("0.6.2", "Remotely Save 本地版", 1000);
    const remote = bundle("0.6.3", "Remotely Save 本地版", 2000);
    const pushOnly = config({ syncDirection: "incremental_push_only" });
    const blocked = await prepare(local, remote, [], pushOnly);
    assert.ok(blocked.filter(a => names.some(n => a.key === root + n)).every(a => a.operation === "skip"));
    const plan = await prepare(local, remote);
    remote.put(root + "manifest.json", JSON.stringify({ id: "remotely-save", name: "Remotely Save 本地版", version: "0.6.4" }), 3000);
    await assert.rejects(() => run(plan, local, remote), /同步过程中发生新修改/);
    assert.deepEqual(local.writes.concat(remote.writes), []);
  });

  it("honors the file size limit for the entire program bundle", async () => {
    const local = bundle("0.6.2", "Remotely Save 本地版", 1000);
    const remote = bundle("0.5.26", "Remotely Save (Fork)", 2000);
    const plan = await prepare(local, remote, [], config({ skipSizeLargerThan: 5 }));
    assert.ok(plan.filter(a => names.some(n => a.key === root + n)).every(a => a.operation === "skip"));
  });

  it("uses recorded history to propagate a one-sided update and detects concurrent edits", async () => {
    const local = bundle("0.6.2", "Remotely Save 本地版", 1000);
    const remote = bundle("0.6.2", "Remotely Save 本地版", 1000);
    const history = await run(await prepare(local, remote), local, remote);
    remote.put(root + "styles.css", "new remote styles", 5000);
    const remoteUpdate = await prepare(local, remote, history);
    assert.ok(remoteUpdate.filter(a => names.some(n => a.key === root + n)).every(a => a.operation === "download"));
    local.put(root + "main.js", "new local code", 6000);
    await assert.rejects(() => prepare(local, remote, history), /同版本插件程序不一致/);
    assert.equal(local.content(root + "data.json"), "private-0.6.2");
  });

  it("runs the actual synchronization flow with program files only", async () => {
    const local = bundle("0.6.2", "Remotely Save 本地版", 1000, "new");
    const remote = bundle("0.5.26", "Remotely Save (Fork)", 2000, "old");
    const table = () => ({ async getItems() { return {}; }, async setItem() {}, async removeItem() {} });
    const db = { prevSyncRecordsTbl: table(), syncPlansTbl: table() } as any;
    const previousMoment = window.moment;
    window.moment = moment as unknown as typeof window.moment;
    try {
      const summary = await syncer(local as any, remote as any, remote as any, undefined, db, "manual", "profile", "vault", ".obsidian", config({ protectModifyPercentage: 100 }), "0.6.2", async () => {}, undefined, async () => {}, async () => {}, async (_source, error) => { throw error; }, async () => {}, async () => {}, async () => {});
      assert.equal(summary.upload, 3);
      assert.equal(summary.download + summary.deleteLocal + summary.deleteRemote, 0);
      assert.deepEqual(remote.writes, names.map(n => root + n));
      assert.equal(local.content(root + "data.json"), "private-new");
      assert.equal(remote.content(root + "data.json"), "private-old");
    } finally {
      window.moment = previousMoment;
    }
  });
});
