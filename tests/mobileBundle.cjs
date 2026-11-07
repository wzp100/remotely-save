const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { TextEncoder, TextDecoder } = require("node:util");
const { JSDOM } = require("jsdom");
const moment = require("moment");

async function runMobile(platform) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://obsidian.example/", runScripts: "outside-only",
  });
  const w = dom.window;
  // Some mobile WebViews lack SubtleCrypto even when secure randomness works.
  Object.defineProperty(w, "crypto", { value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } });
  Object.assign(w, { TextEncoder, TextDecoder, moment, fetch, Headers, Request, Response, AbortController, AbortSignal });
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  const methods = {
    empty() { this.replaceChildren(); },
    addClass(...names) { this.classList.add(...names); },
    setText(value) { this.textContent = value; },
    createEl(tag, options = {}) {
      const el = w.document.createElement(tag);
      if (options.cls) el.className = options.cls;
      if (options.text) el.textContent = options.text;
      if (options.href) el.href = options.href;
      this.appendChild(el);
      return el;
    },
    createDiv(options = {}) { return this.createEl("div", options); },
    createSpan(options = {}) { return this.createEl("span", options); },
  };
  Object.assign(w.Element.prototype, methods);
  const handlers = new Map();
  const tabs = [];
  const prior = {
    serviceType: "onedrive", agreeToUseSyncV3: true,
    autoRunEveryMilliseconds: -1, initRunAfterMilliseconds: -1,
    onedrive: { clientID: "fixture-client", authority: "https://login.microsoftonline.com/consumers", accessToken: "device-access", refreshToken: "device-refresh", accessTokenExpiresAtTime: Date.now() + 3600000, remoteBaseDir: "vault", username: "fixture" },
  };
  class Plugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; }
    async loadData() { return Object.hasOwn(this.app, "fixtureData") ? this.app.fixtureData : prior; }
    async saveData(data) { this.saved = data; this.app.savedFixtureData = data; }
    registerObsidianProtocolHandler(name, callback) { handlers.set(name, callback); }
    addRibbonIcon() { return w.document.createElement("div"); }
    addSettingTab(tab) { tabs.push(tab); }
    addCommand() {}
    registerInterval(id) { return id; }
    registerEvent() {}
  }
  class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = w.document.createElement("div"); } hide() {} }
  class Modal { constructor(app) { this.app = app; this.modalEl = w.document.createElement("div"); this.contentEl = w.document.createElement("div"); } open() { this.ready = Promise.resolve(this.onOpen?.()); } close() { this.onClose?.(); } }
  class Events { on() {} off() {} trigger() {} }
  class Setting {
    constructor(el) { this.settingEl = el.createDiv(); this.control = this.settingEl.createDiv(); }
    setName(value) { this.settingEl.createDiv({ text: value }); return this; }
    setDesc(value) { this.settingEl.createDiv({ text: value }); return this; }
    addButton(fn) {
      const button = this.control.createEl("button");
      const component = {
        setButtonText(value) { button.textContent = value; return this; },
        setCta() { return this; }, setDisabled(value) { button.disabled = value; return this; },
        onClick(callback) { button.action = callback; return this; },
      };
      fn(component); return this;
    }
    component(tag, fn) {
      const input = this.control.createEl(tag);
      const component = {
        inputEl: input,
        setValue(value) { input.value = String(value); return this; },
        setPlaceholder(value) { input.placeholder = value; return this; },
        setDisabled(value) { input.disabled = value; return this; },
        addOption(value, label) { const option = input.createEl("option", { text: label }); option.value = value; return this; },
        onChange(callback) { input.change = callback; return this; },
      };
      fn(component); return this;
    }
    addDropdown(fn) { return this.component("select", fn); }
    addToggle(fn) { return this.component("input", fn); }
    addText(fn) { return this.component("input", fn); }
    addTextArea(fn) { return this.component("textarea", fn); }
  }
  class FileSystemAdapter {}
  class TFile {}
  class TFolder {}
  let tokenBody = "";
  const obsidian = {
    Platform: { isMobile: true, isDesktopApp: false, isIosApp: platform === "ios", isAndroidApp: platform === "android" },
    Plugin, PluginSettingTab, Modal, Setting, Events, FileSystemAdapter, TFile, TFolder,
    Notice: class {}, addIcon() {}, setIcon() {}, requireApiVersion: () => true, moment,
    request: async args => {
      if (args.url.includes("/oauth2/v2.0/token")) {
        tokenBody = args.body;
        return JSON.stringify({ token_type: "Bearer", access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: "" });
      }
      if (args.url.includes("/drive/special/approot/children")) return JSON.stringify({ value: [{ name: "vault" }] });
      if (args.url.includes("/me?")) return JSON.stringify({ displayName: "fixture" });
      throw Error("unexpected network request in mobile bundle smoke test");
    },
    requestUrl: async () => { throw Error("network disabled in mobile bundle smoke test"); },
    normalizePath: p => p,
  };
  const requested = [];
  w.require = id => {
    requested.push(id);
    if (id === "obsidian") return obsidian;
    throw Error(`mobile runtime cannot require ${id}`);
  };
  w.module = { exports: {} };
  w.exports = w.module.exports;
  const adapter = { getResourcePath: () => `capacitor://localhost/${platform}/vault`, exists: async () => false };
  const app = { vault: { adapter, configDir: ".obsidian", getName: () => "vault", on() {}, off() {} }, workspace: { onLayoutReady() {}, on() {} } };
  vm.runInContext(fs.readFileSync("main.js", "utf8"), dom.getInternalVMContext(), { timeout: 10000 });
  const PluginClass = w.module.exports.default;
  assert.equal(typeof PluginClass, "function");
  const plugin = new PluginClass(app, { id: "remotely-save-local", name: "Remotely Save 本地版", version: "0.7.2", dir: ".obsidian/plugins/remotely-save-local" });
  await plugin.onload();
  assert.equal(plugin.settings.onedrive.refreshToken, "device-refresh");
  assert.equal(plugin.settings.onedrive.clientID, "fixture-client");
  assert.equal(plugin.settings.respectGitignore, true);
  assert.ok(handlers.has("remotely-save-cb-onedrive"));
  assert.equal(tabs.length, 1);
  await tabs[0].display();
  assert.match(tabs[0].containerEl.textContent, /遵循 \.gitignore/);
  assert.match(tabs[0].containerEl.textContent, /OneDrive 远程目录/);
  const authorize = [...tabs[0].containerEl.querySelectorAll("button")].find(b => b.textContent === "重新授权");
  assert.ok(authorize);
  authorize.action();
  const modal = plugin.oauth2Info.helperModal;
  await modal.ready;
  const authUrl = new URL(modal.contentEl.querySelector("a").href);
  const state = authUrl.searchParams.get("state");
  assert.ok(state);
  tabs[0].hide();
  const restarted = new PluginClass(app, { id: "remotely-save-local", name: "Remotely Save 本地版", version: "0.7.2", dir: ".obsidian/plugins/remotely-save-local" });
  await restarted.onload();
  const callback = handlers.get("remotely-save-cb-onedrive");
  await callback({ code: "fixture-code", state: "incorrect-state" });
  assert.equal(restarted.settings.onedrive.refreshToken, "device-refresh");
  await callback({ code: "fixture-code", state });
  assert.equal(restarted.settings.onedrive.refreshToken, "new-refresh");
  const verifier = new URLSearchParams(tokenBody).get("code_verifier");
  assert.equal(require("node:crypto").createHash("sha256").update(verifier).digest("base64url"), authUrl.searchParams.get("code_challenge"));
  const legacyDir = ".obsidian/plugins/remotely-save/";
  const bootstrapRule = "^(?!\\.obsidian/(?:plugins/(?:remotely-save-local/(?:main\\.js|styles\\.css|manifest\\.json)?)?)?$)";
  const bootstrapConfigWasOff = "^(?!)rs-local-config-was-off$";
  const bootstrapAllow = "^\\.obsidian/(?:plugins/(?:remotely-save-local/(?:main\\.js|styles\\.css|manifest\\.json)?)?)?$";
  const legacyData = { ...prior, syncConfigDir: true, ignorePaths: ["keep-this-rule", bootstrapRule, bootstrapConfigWasOff], onlyAllowPaths: ["keep-allow-rule", bootstrapAllow] };
  const legacyAdapter = {
    getResourcePath: () => `capacitor://localhost/${platform}/legacy-vault`,
    exists: async path => path === legacyDir + "data.json",
    read: async path => {
      if (path === legacyDir + "data.json") return JSON.stringify(legacyData);
      if (path === legacyDir + "manifest.json") return JSON.stringify({ id: "remotely-save", name: "Remotely Save" });
      throw Error("unexpected legacy file");
    },
  };
  const legacyApp = { ...app, fixtureData: null, vault: { ...app.vault, adapter: legacyAdapter }, plugins: { enabledPlugins: new Set(["remotely-save"]) } };
  const migrated = new PluginClass(legacyApp, { id: "remotely-save-local", name: "Remotely Save 本地版", version: "0.7.2", dir: ".obsidian/plugins/remotely-save-local" });
  await assert.rejects(() => migrated.onload(), /旧版 Remotely Save/);
  legacyApp.plugins.enabledPlugins.clear();
  await migrated.onload();
  assert.equal(migrated.settings.onedrive.refreshToken, "device-refresh");
  assert.match(migrated.getCurrProfileID(), /^onedrive-folder-/);
  assert.deepEqual(Array.from(migrated.settings.ignorePaths), ["keep-this-rule"]);
  assert.deepEqual(Array.from(migrated.settings.onlyAllowPaths), ["keep-allow-rule"]);
  assert.equal(migrated.settings.syncConfigDir, false);
  assert.ok(legacyApp.savedFixtureData);
  assert.ok(requested.every(id => id === "obsidian"), requested.join(", "));
  dom.window.close();
  return { platform, loaded: true, authPreserved: true, externalModules: [...new Set(requested)] };
}

(async () => {
  const results = [];
  for (const platform of ["ios", "android"]) results.push(await runMobile(platform));
  console.log(JSON.stringify(results, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
