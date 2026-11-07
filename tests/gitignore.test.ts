import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entity, RemotelySavePluginSettings } from "../src/baseTypes";
import { GitIgnoreFilter, loadGitIgnore, saveRootGitIgnore } from "../src/gitignore";
import { planSync, type BasicHistory } from "../src/syncPlan";

const entity = (key: string): Entity => ({ key, keyRaw: key, mtimeCli: 1000, size: 10, sizeRaw: 10 });
const settings = { syncConfigDir: true, syncDirection: "bidirectional", conflictAction: "keep_newer" } as RemotelySavePluginSettings;

describe("Vault .gitignore compatibility", () => {
  it("supports nested rules, negation and excluded parent directories", () => {
    const filter = new GitIgnoreFilter([
      { directory: "", content: "*.tmp\n/cache/\n!cache/keep.txt\n/build/*\n!/build/keep.txt\n" },
      { directory: "docs", content: "*.md\n!keep.md\n" },
    ]);
    assert.equal(filter.ignores("note.tmp"), true);
    assert.equal(filter.ignores("cache/keep.txt"), true);
    assert.equal(filter.ignores("build/out.js"), true);
    assert.equal(filter.ignores("build/keep.txt"), false);
    assert.equal(filter.ignores("docs/a.md"), true);
    assert.equal(filter.ignores("docs/keep.md"), false);
    assert.equal(filter.ignores("other/a.md"), false);
  });

  it("agrees with git check-ignore for representative root and nested patterns", function () {
    if (spawnSync("git", ["--version"]).status !== 0) this.skip();
    const dir = mkdtempSync(join(tmpdir(), "rs-gitignore-"));
    try {
      execFileSync("git", ["init", "-q", dir]);
      mkdirSync(join(dir, "docs", "drafts"), { recursive: true });
      const top = "# comment\n*.tmp\n/cache/\n!cache/keep.txt\n/build/*\n!/build/keep.txt\n/docs/*.log\n!important.tmp\n**/blocked?.md\nspace\\ file.txt\n";
      const nested = "*.md\n!keep.md\ndrafts/\n";
      writeFileSync(join(dir, ".gitignore"), top);
      writeFileSync(join(dir, "docs", ".gitignore"), nested);
      const filter = new GitIgnoreFilter([{ directory: "", content: top }, { directory: "docs", content: nested }]);
      for (const key of ["one.tmp", "important.tmp", "cache/keep.txt", "build/out.js", "build/keep.txt", "docs/a.md", "docs/keep.md", "docs/drafts/keep.md", "docs/a.log", "nested/blocked1.md", "space file.txt", "other/file.md"]) {
        const status = spawnSync("git", ["-C", dir, "check-ignore", "--no-index", "-q", key]).status;
        assert.ok(status === 0 || status === 1, `git failed for ${key}`);
        assert.equal(filter.ignores(key), status === 0, key);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes ignored paths on both sides and from deletion history", () => {
    const a = entity("private/secret.md"), b = entity("public.md");
    const history: BasicHistory[] = [{ ...a, basicLocal: a, basicRemote: a }];
    const filter = new GitIgnoreFilter([{ directory: "", content: "private/\n" }]);
    const plan = planSync([b], [a], history, settings, ".obsidian", filter);
    assert.deepEqual(plan.map(item => [item.key, item.operation]), [["public.md", "upload"]]);
  });

  it("loads rules from local directories and fails closed when they cannot be read", async () => {
    const files = new Map([[".gitignore", "*.tmp\n"], ["docs/.gitignore", "private/\n"]]);
    const adapter = { exists: async (key: string) => files.has(key), read: async (key: string) => files.get(key)! };
    const filter = await loadGitIgnore(adapter, [entity("docs/a.md"), entity("other/x.md")]);
    assert.equal(filter.ignores("a.tmp"), true);
    assert.equal(filter.ignores("docs/private/a.md"), true);
    assert.equal(filter.ignores("other/private/a.md"), false);
    await assert.rejects(() => loadGitIgnore({ exists: async () => true, read: async () => { throw new Error("permission denied"); } }, []), /停止同步/);
  });

  it("never lets negation include a device-specific authorization file", () => {
    const filter = new GitIgnoreFilter([{ directory: "", content: "!/.obsidian/plugins/remotely-save/data.json\n!/.obsidian/plugins/remotely-save-local/data.json\n" }]);
    for (const key of [".obsidian/plugins/remotely-save/data.json", ".obsidian/plugins/remotely-save-local/data.json"]) {
      assert.deepEqual(planSync([entity(key)], [entity(key)], [], settings, ".obsidian", filter), []);
    }
  });

  it("saves the root file without overwriting concurrent edits", async () => {
    let content: string | null = "old/\n";
    const adapter = {
      exists: async () => content !== null,
      read: async () => content!,
      write: async (_key: string, value: string) => { content = value; },
    };
    await saveRootGitIgnore(adapter, "old/\n", "new/\n");
    assert.equal(content, "new/\n");
    await assert.rejects(() => saveRootGitIgnore(adapter, "old/\n", "lost/\n"), /其他程序修改/);
    assert.equal(content, "new/\n");
    content = null;
    await saveRootGitIgnore(adapter, null, "created/\n");
    assert.equal(content, "created/\n");
  });
});
