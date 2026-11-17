import { strict as assert } from "node:assert";
import { cleanBackups, listBackups, parseBatchTime } from "../src/conflictBackups";

class FakeAdapter {
  files = new Map<string, number>();
  constructor(paths: Record<string, number>) { for (const [k, v] of Object.entries(paths)) this.files.set(k, v); }
  async exists(p: string) { return [...this.files.keys()].some(k => k === p || k.startsWith(p + "/")); }
  async list(p: string) {
    const files = new Set<string>(), folders = new Set<string>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(p + "/")) continue;
      const rest = k.slice(p.length + 1).split("/");
      if (rest.length === 1) files.add(k); else folders.add(`${p}/${rest[0]}`);
    }
    return { files: [...files], folders: [...folders] };
  }
  async stat(p: string) { return this.files.has(p) ? { size: this.files.get(p)! } : null; }
  async rmdir(p: string) { for (const k of [...this.files.keys()]) if (k.startsWith(p + "/")) this.files.delete(k); }
}

describe("Config conflict backups", () => {
  const root = ".obsidian/plugins/remotely-save-local/conflict-backups";
  const now = new Date(2026, 10, 17, 12, 0, 0).getTime();
  const make = () => new FakeAdapter({
    [`${root}/2026-11-16 090000/本机/app.json`]: 100,
    [`${root}/2026-11-16 090000/云端/plugins/x/data.json`]: 50,
    [`${root}/2026-09-01 080000/本机/app.json`]: 10,
    [`${root}/notes-i-made/keep.md`]: 5,
  });
  it("parses batch folder names and ignores anything else", () => {
    assert.equal(parseBatchTime("2026-11-16 090000"), new Date(2026, 10, 16, 9, 0, 0).getTime());
    assert.equal(parseBatchTime("notes-i-made"), undefined);
  });
  it("lists batches newest first with file counts and sizes", async () => {
    const batches = await listBackups(make(), root);
    assert.deepEqual(batches.map(b => [b.path.split("/").pop(), b.files, b.bytes]), [["2026-11-16 090000", 2, 150], ["2026-09-01 080000", 1, 10]]);
  });
  it("removes only batches past the retention period and never unknown folders", async () => {
    const a = make();
    assert.equal(await cleanBackups(a, root, 30 * 86400000, now), 1);
    assert.ok(a.files.has(`${root}/2026-11-16 090000/本机/app.json`));
    assert.ok(!a.files.has(`${root}/2026-09-01 080000/本机/app.json`));
    assert.equal(await cleanBackups(a, root, 0, now), 1);
    assert.ok(a.files.has(`${root}/notes-i-made/keep.md`));
  });
});
