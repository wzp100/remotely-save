import { strict as assert } from "node:assert";
import { BOOTSTRAP_ALLOW_PROGRAMS_RULE, BOOTSTRAP_CONFIG_WAS_OFF_RULE, BOOTSTRAP_ONLY_PROGRAMS_RULE, legacyPluginEnabled, loadLocalOrLegacySettings } from "../src/pluginMigration";

describe("Local plugin ID migration", () => {
  const data = { onedrive: { refreshToken: "per-device-fixture", remoteBaseDir: "vault" } };
  const base = ".obsidian/plugins/remotely-save/";

  function adapter(manifest: object | null) {
    const files: Record<string, string> = { [base + "data.json"]: JSON.stringify(data) };
    if (manifest) files[base + "manifest.json"] = JSON.stringify(manifest);
    return {
      exists: async (path: string) => path in files,
      read: async (path: string) => {
        if (!(path in files)) throw Error("not found");
        return files[path];
      },
    };
  }

  it("copies legacy settings only from the same device and identifies the local fork", async () => {
    const localFork = await loadLocalOrLegacySettings(null, adapter({ id: "remotely-save", name: "Remotely Save 本地版" }), ".obsidian");
    assert.deepEqual(localFork, { data, legacy: true, localFork: true });
    const upstream = await loadLocalOrLegacySettings(null, adapter({ id: "remotely-save", name: "Remotely Save" }), ".obsidian");
    assert.deepEqual(upstream, { data, legacy: true, localFork: false });
    assert.equal((await loadLocalOrLegacySettings(null, adapter(null), ".obsidian")).localFork, false);
  });

  it("never reads or replaces existing local settings", async () => {
    const current = { onedrive: { refreshToken: "new-device-token" } };
    const forbidden = { exists: async () => { throw Error("must not inspect old settings"); }, read: async () => { throw Error("must not inspect old settings"); } };
    assert.deepEqual(await loadLocalOrLegacySettings(current, forbidden, ".obsidian"), { data: current, legacy: false, localFork: false });
  });

  it("fails closed on invalid legacy data and detects an enabled old plugin", async () => {
    const invalid = { exists: async () => true, read: async () => "not json" };
    await assert.rejects(() => loadLocalOrLegacySettings(null, invalid, ".obsidian"));
    assert.equal(legacyPluginEnabled({ plugins: { enabledPlugins: new Set(["remotely-save"]) } }), true);
    assert.equal(legacyPluginEnabled({ plugins: { plugins: { "remotely-save": {} } } }), true);
    assert.equal(legacyPluginEnabled({ plugins: { enabledPlugins: new Set(["remotely-save-local"]) } }), false);
  });

  it("limits the one-time bootstrap to the three program files and parent folders", () => {
    const ignored = new RegExp(BOOTSTRAP_ONLY_PROGRAMS_RULE);
    for (const key of [".obsidian/", ".obsidian/plugins/", ".obsidian/plugins/remotely-save-local/", ...["main.js", "styles.css", "manifest.json"].map(x => ".obsidian/plugins/remotely-save-local/" + x)]) {
      assert.equal(ignored.test(key), false, key);
      assert.equal(new RegExp(BOOTSTRAP_ALLOW_PROGRAMS_RULE).test(key), true, key);
    }
    for (const key of [".obsidian/plugins/remotely-save/data.json", ".obsidian/plugins/remotely-save-local/data.json", ".obsidian/plugins/other/data.json", "notes/a.md"]) {
      assert.equal(ignored.test(key), true, key);
      assert.equal(new RegExp(BOOTSTRAP_ALLOW_PROGRAMS_RULE).test(key), false, key);
      assert.equal(new RegExp(BOOTSTRAP_CONFIG_WAS_OFF_RULE).test(key), false, key);
    }
  });
});
