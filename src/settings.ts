// Local fork: one integrated settings tab — status dashboard first, then grouped settings.
import { App, Modal, Notice, PluginSettingTab, Setting, arrayBufferToBase64, setIcon } from "obsidian";
import type RemotelySavePlugin from "./main";
import type {
  RemotelySavePluginSettings,
  SyncDirectionType,
  SyncTriggerSourceType,
} from "./baseTypes";
import { getClient } from "./fsGetter";
import { getAuthUrlAndVerifier } from "./fsOnedrive";
import { saveOneDriveAuthSession } from "./onedriveAuthSession";
import { saveRootGitIgnore } from "./gitignore";
import { changeOneDriveFolder } from "./onedriveFolder";
import {
  getCachedAvatarByVault,
  getLastFailedSyncTimeByVault,
  getLastSuccessSyncTimeByVault,
  upsertCachedAvatarByVault,
} from "./localdb";

const SERVICES: Record<string, string> = {
  onedrive: "OneDrive",
  s3: "S3 / R2",
  webdav: "WebDAV",
  dropbox: "Dropbox",
  webdis: "Webdis",
};

const SOURCE_LABELS: Record<SyncTriggerSourceType, string> = {
  manual: "手动同步",
  dry: "同步预览",
  auto: "自动同步",
  auto_once_init: "启动同步",
  auto_sync_on_save: "保存后同步",
};

const OPERATIONS: Record<string, { label: string; icon: string; tone: string }> = {
  upload: { label: "上传", icon: "arrow-up", tone: "accent" },
  download: { label: "下载", icon: "arrow-down", tone: "green" },
  delete_local: { label: "删除本地", icon: "trash", tone: "red" },
  delete_remote: { label: "删除云端", icon: "trash", tone: "red" },
  mkdir_local: { label: "新建本地文件夹", icon: "folder", tone: "muted" },
  mkdir_remote: { label: "新建云端文件夹", icon: "folder", tone: "muted" },
  equal: { label: "一致", icon: "check", tone: "muted" },
  forget: { label: "清理记录", icon: "eraser", tone: "muted" },
  skip: { label: "跳过", icon: "minus", tone: "muted" },
};

const intervalLabel = (n?: number) =>
  !n || n < 0 ? "关闭" : n < 60000 ? `${n / 1000} 秒` : n < 3600000 ? `${n / 60000} 分钟` : `${n / 3600000} 小时`;

const formatDuration = (ms?: number) => {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  return s % 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s / 60} 分钟`;
};

const formatTime = (ms?: number) => (ms ? new Date(ms).toLocaleString() : "暂无记录");

const relativeTime = (ms?: number) => {
  if (!ms) return "暂无记录";
  const d = Date.now() - ms;
  if (d < 60000) return "刚刚";
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  if (d < 7 * 86400000) return `${Math.floor(d / 86400000)} 天前`;
  return new Date(ms).toLocaleDateString();
};

type Disableable = { setDisabled(v: boolean): unknown };

export class RemotelySaveSettingTab extends PluginSettingTab {
  private statusTimer?: number;
  private statusEl?: HTMLElement;
  private statusKey = "";
  private actionsOpen = false;
  private syncButtons: Disableable[] = [];
  private storedSuccess?: number;
  private storedFailure?: number;

  constructor(app: App, readonly plugin: RemotelySavePlugin) {
    super(app, plugin);
  }

  async save(patch: Partial<RemotelySavePluginSettings>) {
    if (this.plugin.isSyncing) throw new Error("同步过程中请等待完成后再修改设置。");
    const old = { ...this.plugin.settings };
    Object.assign(this.plugin.settings, patch);
    try {
      await this.plugin.saveSettings();
    } catch (error) {
      Object.assign(this.plugin.settings, old);
      throw error;
    }
    if ("autoRunEveryMilliseconds" in patch) this.plugin.enableAutoSyncIfSet();
    if ("syncOnSaveAfterMilliseconds" in patch) this.plugin.toggleSyncOnSaveIfSet();
  }

  /** Runs a change; only re-renders the page when asked to, or to restore controls after a failure. */
  async action(control: Disableable, fn: () => Promise<unknown>, rerender = false) {
    control.setDisabled(true);
    let failed = false;
    try {
      await fn();
    } catch (error) {
      failed = true;
      new Notice((error as Error).message, 10000);
    } finally {
      control.setDisabled(false);
    }
    if (rerender || failed) await this.display();
    else this.renderStatus(true);
  }

  async display() {
    this.stopStatusTimer();
    const root = this.containerEl;
    const scroller = root.closest<HTMLElement>(".vertical-tab-content-container");
    const scrollTop = [root.scrollTop, scroller?.scrollTop ?? 0];
    root.empty();
    root.addClass("rs-console");
    this.syncButtons = [];
    this.statusKey = "";

    this.renderDashboard(root);
    this.renderConnection(root);
    this.renderSchedule(root);
    this.renderContent(root);
    this.renderSafety(root);
    this.renderAdvanced(root);

    root.scrollTop = scrollTop[0];
    if (scroller) scroller.scrollTop = scrollTop[1];
    this.startStatusTimer();

    const [success, failed] = await Promise.all([
      getLastSuccessSyncTimeByVault(this.plugin.db, this.plugin.vaultRandomID),
      getLastFailedSyncTimeByVault(this.plugin.db, this.plugin.vaultRandomID),
    ]).catch(() => [undefined, undefined]);
    this.storedSuccess = success ?? undefined;
    this.storedFailure = failed ?? undefined;
    this.renderStatus(true);
  }

  hide() {
    this.stopStatusTimer();
    this.statusEl = undefined;
    this.syncButtons = [];
    super.hide();
  }

  // ───────────────────────── dashboard ─────────────────────────

  private renderDashboard(root: HTMLElement) {
    const card = root.createDiv({ cls: "rs-dashboard" });
    const top = card.createDiv({ cls: "rs-dash-top" });
    this.statusEl = top.createDiv({ cls: "rs-dash-status" });
    const actions = top.createDiv({ cls: "rs-dash-actions" });

    const sync = actions.createEl("button", { cls: "mod-cta rs-btn" });
    this.iconText(sync, "refresh-cw", "立即同步");
    const preview = actions.createEl("button", { cls: "rs-btn" });
    this.iconText(preview, "eye", "预览");
    preview.title = "只比对本地与云端，列出将要发生的变化，不修改任何文件";
    const run = (btn: HTMLButtonElement, source: SyncTriggerSourceType) =>
      btn.addEventListener("click", async () => {
        this.actionsOpen = source === "dry";
        const control = { setDisabled: (v: boolean) => { btn.disabled = v; } };
        await this.action(control, () => this.plugin.syncRun(source));
      });
    run(sync, "manual");
    run(preview, "dry");
    for (const b of [sync, preview]) this.syncButtons.push({ setDisabled: (v) => { b.disabled = v; } });

    card.createDiv({ cls: "rs-dash-detail" });
    this.renderStatus(true);
  }

  private state(): "syncing" | "preview" | "failed" | "ok" | "never" {
    const p = this.plugin;
    if (p.isSyncing) return p.syncTriggerSource === "dry" ? "preview" : "syncing";
    if (p.syncPhase === "failed" || p.lastSyncError) return "failed";
    return this.lastSuccess() ? "ok" : "never";
  }

  private lastSuccess() { return this.plugin.lastSyncSuccessAt ?? this.storedSuccess; }
  private lastFailure() { return this.plugin.lastSyncFailureAt ?? this.storedFailure; }

  private renderStatus(force = false) {
    const status = this.statusEl;
    const detail = status?.closest(".rs-dashboard")?.querySelector<HTMLElement>(".rs-dash-detail");
    if (!status || !detail) return;
    const p = this.plugin;
    const state = this.state();
    const busy = state === "syncing" || state === "preview";
    for (const b of this.syncButtons) b.setDisabled(busy);

    // Rebuild only when something visible changed, so expanded lists and scroll positions survive.
    const minute = Math.floor(Date.now() / 30000);
    const key = JSON.stringify([state, busy ? Math.floor((Date.now() - (p.syncStartedAt ?? 0)) / 1000) : minute,
      p.syncProgress, p.lastSyncError, p.lastSyncFinishedAt, this.lastSuccess(), this.lastFailure(), p.syncTriggerSource]);
    if (!force && key === this.statusKey) return;
    this.statusKey = key;

    const card = status.closest(".rs-dashboard")!;
    card.className = `rs-dashboard is-${state}`;
    status.empty();
    const icon = status.createDiv({ cls: "rs-dash-icon" });
    setIcon(icon, { syncing: "refresh-cw", preview: "eye", failed: "alert-triangle", ok: "check", never: "cloud" }[state]);
    const text = status.createDiv({ cls: "rs-dash-text" });
    const source = p.syncTriggerSource ? SOURCE_LABELS[p.syncTriggerSource] : "";
    const title = {
      syncing: "正在同步",
      preview: "正在生成预览",
      failed: "同步失败",
      ok: `已同步 · ${relativeTime(this.lastSuccess())}`,
      never: "尚未同步",
    }[state];
    text.createDiv({ cls: "rs-dash-title", text: title });
    const cloud = this.cloud();
    const sub = [SERVICES[p.settings.serviceType], `「${cloud.remoteBaseDir || this.app.vault.getName()}」`];
    if (busy) {
      sub.push(source, p.syncStartedAt ? `已用时 ${formatDuration(Date.now() - p.syncStartedAt)}` : "");
    } else if (p.lastSyncFinishedAt) {
      sub.push(source, formatDuration(p.lastSyncDurationMs) ? `用时 ${formatDuration(p.lastSyncDurationMs)}` : "");
    }
    const subEl = text.createDiv({ cls: "rs-dash-sub", text: sub.filter(Boolean).join(" · ") });
    if (this.lastSuccess()) subEl.title = `最近成功：${formatTime(this.lastSuccess())}\n最近失败：${formatTime(this.lastFailure())}`;

    detail.empty();
    if (busy) {
      const progress = p.syncProgress;
      const bar = detail.createDiv({ cls: "rs-progress" });
      const fill = bar.createDiv({ cls: "rs-progress-fill" });
      if (progress && progress.total > 0) {
        const percent = Math.min(100, (progress.done * 100) / progress.total);
        fill.style.width = `${percent}%`;
        const line = detail.createDiv({ cls: "rs-progress-line" });
        line.createSpan({ cls: "rs-progress-count", text: `${progress.done}/${progress.total} · ${percent.toFixed(0)}%` });
        const op = OPERATIONS[progress.decision];
        line.createSpan({ cls: "rs-progress-path", text: `${op?.label ?? progress.decision}  ${progress.path}` });
      } else {
        bar.addClass("is-indeterminate");
        detail.createDiv({ cls: "rs-muted", text: state === "preview" ? "正在比对本地与云端，预览不会修改任何文件…" : "正在比对本地与云端文件…" });
      }
      return;
    }

    if (p.lastSyncError) {
      const err = detail.createDiv({ cls: "rs-error-box" });
      setIcon(err.createSpan({ cls: "rs-error-icon" }), "alert-triangle");
      err.createSpan({ text: p.lastSyncError });
    }

    const summary = p.lastSyncSummary;
    if (!summary) return;
    const stats = detail.createDiv({ cls: "rs-stats" });
    stats.createSpan({ cls: "rs-stats-label", text: summary.dry ? "预览结果" : "上次同步" });
    const chips: [string, number, string, string][] = [
      ["上传", summary.upload, "arrow-up", "accent"],
      ["下载", summary.download, "arrow-down", "green"],
      ["删除", summary.deleteLocal + summary.deleteRemote, "trash", "red"],
      ["冲突", summary.conflicts, "git-merge", "yellow"],
    ];
    let any = false;
    for (const [label, n, ic, tone] of chips) {
      if (!n) continue;
      any = true;
      const chip = stats.createSpan({ cls: `rs-chip tone-${tone}` });
      setIcon(chip.createSpan({ cls: "rs-chip-icon" }), ic);
      chip.createSpan({ text: `${label} ${n}` });
    }
    if (!any) stats.createSpan({ cls: "rs-chip tone-muted", text: "没有变化" });

    if (summary.actions.length) {
      const list = detail.createEl("details", { cls: "rs-ops" });
      list.open = this.actionsOpen;
      list.addEventListener("toggle", () => { this.actionsOpen = list.open; });
      list.createEl("summary", { text: `${summary.dry ? "将要执行" : "已执行"}的操作（${summary.actions.length}）` });
      const ul = list.createDiv({ cls: "rs-ops-list" });
      for (const a of summary.actions.slice(0, 300)) {
        const op = OPERATIONS[a.operation] ?? { label: a.operation, icon: "dot", tone: "muted" };
        const row = ul.createDiv({ cls: `rs-op tone-${a.conflict ? "yellow" : op.tone}` });
        setIcon(row.createSpan({ cls: "rs-op-icon" }), a.conflict ? "git-merge" : op.icon);
        row.createSpan({ cls: "rs-op-label", text: a.conflict ? `冲突·${op.label}` : op.label });
        const pathEl = row.createSpan({ cls: "rs-op-path", text: a.path });
        pathEl.title = a.path;
        if (a.conflict) {
          const keep = a.operation === "download" ? "本机" : "云端";
          const note = a.copy
            ? `原${keep}版本已另存为：${a.copy}`
            : summary.dry
              ? `两端都改过；同步时若内容不同，${keep}版本会先另存再被替换`
              : `原${keep}版本未保存`;
          const sub = ul.createDiv({ cls: "rs-op-note", text: note });
          sub.title = note;
        }
      }
      if (summary.actions.length > 300) ul.createDiv({ cls: "rs-muted", text: `另有 ${summary.actions.length - 300} 项未显示` });
      if (summary.dry && summary.actions.length) {
        const hint = list.createDiv({ cls: "rs-muted rs-ops-hint", text: "确认无误后点击「立即同步」执行。" });
        hint.setAttr("role", "note");
      }
    }
  }

  // ───────────────────────── sections ─────────────────────────

  private cloud() {
    const s = this.plugin.settings;
    return (s[s.serviceType] ?? {}) as { remoteBaseDir?: string; username?: string; refreshToken?: string; accessToken?: string };
  }

  private section(root: HTMLElement, icon: string, title: string, desc?: string) {
    const card = root.createDiv({ cls: "rs-card" });
    const head = card.createDiv({ cls: "rs-card-head" });
    setIcon(head.createSpan({ cls: "rs-card-icon" }), icon);
    const t = head.createDiv();
    t.createDiv({ cls: "rs-card-title", text: title });
    if (desc) t.createDiv({ cls: "rs-card-desc", text: desc });
    return card.createDiv({ cls: "rs-card-body" });
  }

  private renderConnection(root: HTMLElement) {
    const s = this.plugin.settings;
    const cloud = this.cloud();
    const body = this.section(root, "cloud", "账号与连接");
    const authorized = !!(cloud.refreshToken || cloud.accessToken);

    const account = body.createDiv({ cls: "rs-account" });
    const avatar = account.createDiv({ cls: "rs-avatar" });
    this.avatarFallback(avatar, cloud.username);
    if (s.serviceType === "onedrive" && authorized) {
      avatar.addClass("is-clickable");
      avatar.title = "点击刷新微软账号头像";
      avatar.addEventListener("click", () => void this.loadAvatar(avatar, cloud.username ?? "", true));
      void this.loadAvatar(avatar, cloud.username ?? "");
    }
    const info = account.createDiv({ cls: "rs-account-info" });
    info.createDiv({ cls: "rs-account-name", text: cloud.username || (authorized ? "已授权账号" : "尚未登录") });
    const meta = info.createDiv({ cls: "rs-account-meta" });
    meta.createSpan({ cls: `rs-badge ${authorized ? "tone-green" : "tone-red"}`, text: authorized ? "已授权" : "未授权" });
    meta.createSpan({ text: SERVICES[s.serviceType] });
    meta.createSpan({ cls: `rs-badge ${s.password ? "tone-green" : "tone-muted"}`, text: s.password ? "已加密" : "未加密" });

    const buttons = account.createDiv({ cls: "rs-account-actions" });
    const check = buttons.createEl("button", { cls: "rs-btn" });
    this.iconText(check, "plug", "检查连接");
    check.addEventListener("click", () =>
      this.action({ setDisabled: (v) => { check.disabled = v; } }, async () => {
        await getClient(this.plugin.settings, this.app.vault.getName(), () => this.plugin.saveSettings()).walkPartial();
        new Notice("连接正常，授权可用。");
      })
    );
    if (s.serviceType === "onedrive") {
      const auth = buttons.createEl("button", { cls: authorized ? "rs-btn" : "rs-btn mod-cta" });
      this.iconText(auth, "log-in", authorized ? "重新授权" : "登录 OneDrive");
      auth.addEventListener("click", () => {
        const modal = new OnedriveAuthModal(this.app, this.plugin);
        this.plugin.oauth2Info.helperModal = modal;
        modal.open();
      });

      let folder = s.onedrive.remoteBaseDir ?? "";
      new Setting(body)
        .setName("远程目录")
        .setDesc("OneDrive「应用/…」下的文件夹，所有设备必须一致；留空则使用笔记库名称。更换后会重新建立同步历史。")
        .addText((t) => t.setPlaceholder(this.app.vault.getName()).setValue(folder).onChange((v) => { folder = v; }))
        .addButton((b) =>
          b.setButtonText("保存").onClick(() =>
            this.action(b, async () => {
              const updated = changeOneDriveFolder(this.plugin.settings.onedrive, folder);
              if (updated === this.plugin.settings.onedrive) return;
              await this.save({ onedrive: updated });
              new Notice("远程目录已保存。");
            }, true)
          )
        );
    } else {
      new Setting(body).setName("远程目录").setDesc(cloud.remoteBaseDir || this.app.vault.getName());
    }
  }

  private renderSchedule(root: HTMLElement) {
    const s = this.plugin.settings;
    const body = this.section(root, "clock", "自动同步");
    this.interval(body, "定时同步", "Obsidian 打开期间按间隔在后台同步。", s.autoRunEveryMilliseconds,
      [-1, 60000, 300000, 600000, 900000, 1800000, 3600000], (n) => this.save({ autoRunEveryMilliseconds: n }));
    this.interval(body, "启动后同步", "打开笔记库后延迟多久同步一次。", s.initRunAfterMilliseconds,
      [-1, 1000, 5000, 10000, 30000, 60000], (n) => this.save({ initRunAfterMilliseconds: n }));
    this.interval(body, "保存后同步", "停止编辑多久后自动同步；间隔太短会频繁请求网络。", s.syncOnSaveAfterMilliseconds,
      [-1, 1000, 3000, 5000, 10000, 30000, 60000], (n) => this.save({ syncOnSaveAfterMilliseconds: n }));
  }

  private renderContent(root: HTMLElement) {
    const s = this.plugin.settings;
    const body = this.section(root, "folder-sync", "同步内容", "笔记始终同步；以下决定额外同步哪些内容。");
    this.toggle(body, "Obsidian 配置", "外观、快捷键、其他插件及其设置。各设备的同步授权始终不会同步。",
      !!s.syncConfigDir, (v) => this.save({ syncConfigDir: v }));
    this.toggle(body, "书签", "仅同步 bookmarks.json（关闭配置同步时也生效）。",
      !!s.syncBookmarks, (v) => this.save({ syncBookmarks: v }));
    this.toggle(body, "本插件程序", "新版本会经云端自动分发到其他设备，只含 main.js、manifest.json、styles.css。",
      s.syncLocalPlugin !== false, (v) => this.save({ syncLocalPlugin: v }));
    this.toggle(body, "下划线开头的文件", "例如 _templates/、_attachments/。",
      !!s.syncUnderscoreItems, (v) => this.save({ syncUnderscoreItems: v }));
    const git = this.toggle(body, "遵循 .gitignore", "匹配的文件不上传、不下载、不删除；规则只保存在本设备。",
      s.respectGitignore !== false, (v) => this.save({ respectGitignore: v }));
    git.addExtraButton((b) => b.setIcon("pencil").setTooltip("编辑根目录 .gitignore").onClick(() => new GitIgnoreModal(this.app, this.plugin).open()));
  }

  private renderSafety(root: HTMLElement) {
    const s = this.plugin.settings;
    const body = this.section(root, "shield", "冲突与安全");
    new Setting(body)
      .setName("同步方向")
      .setDesc("一般保持双向同步；单向模式适合只做备份或只读设备。")
      .addDropdown((d) => {
        const choices: Record<SyncDirectionType, string> = {
          bidirectional: "双向同步",
          incremental_push_only: "仅上传（不删除）",
          incremental_pull_only: "仅下载（不删除）",
          incremental_push_and_delete_only: "仅上传，并同步删除",
          incremental_pull_and_delete_only: "仅下载，并同步删除",
        };
        for (const [key, label] of Object.entries(choices)) d.addOption(key, label);
        d.setValue(s.syncDirection ?? "bidirectional").onChange((v) =>
          this.action(d, () => this.save({ syncDirection: v as SyncDirectionType })));
      });
    new Setting(body)
      .setName("两端都修改时")
      .setDesc("被替换的笔记另存为「原名 (冲突 本机/云端 时间)」；.obsidian 配置文件备份在本插件目录的 conflict-backups 里，只留在本设备。")
      .addDropdown((d) =>
        d.addOption("keep_newer", "保留较新的")
          .addOption("keep_larger", "保留较大的")
          .setValue(s.conflictAction ?? "keep_newer")
          .onChange((v) => this.action(d, () => this.save({ conflictAction: v as "keep_newer" | "keep_larger" }))));
    new Setting(body)
      .setName("修改保护")
      .setDesc("一次要覆盖或删除的文件超过此比例时停止同步，防止误删。")
      .addDropdown((d) => {
        for (const n of new Set([10, 25, 50, 75, 100, s.protectModifyPercentage ?? 50]))
          d.addOption(String(n), n >= 100 ? "关闭" : `超过 ${n}%`);
        d.setValue(String(s.protectModifyPercentage ?? 50)).onChange((v) =>
          this.action(d, () => this.save({ protectModifyPercentage: Number(v) })));
      });
  }

  private renderAdvanced(root: HTMLElement) {
    const s = this.plugin.settings;
    const wrap = root.createEl("details", { cls: "rs-card rs-advanced" });
    const head = wrap.createEl("summary", { cls: "rs-card-head" });
    setIcon(head.createSpan({ cls: "rs-card-icon" }), "settings");
    const t = head.createDiv();
    t.createDiv({ cls: "rs-card-title", text: "高级" });
    const rules = (s.ignorePaths?.length ?? 0) + (s.onlyAllowPaths?.length ?? 0);
    t.createDiv({ cls: "rs-card-desc", text: `并发 ${s.concurrency ?? 5} · 路径规则 ${rules} 条` });
    const body = wrap.createDiv({ cls: "rs-card-body" });

    new Setting(body)
      .setName("并发数")
      .setDesc("同时传输的文件数；网络不稳定时调低。")
      .addDropdown((d) => {
        for (const n of new Set([1, 2, 3, 5, 10, s.concurrency ?? 5])) d.addOption(String(n), String(n));
        d.setValue(String(s.concurrency ?? 5)).onChange((v) => this.action(d, () => this.save({ concurrency: Number(v) }), true));
      });
    for (const [key, label, desc] of [
      ["ignorePaths", "忽略路径", "匹配的路径不参与同步。每行一个正则表达式，例如 ^Archive/"],
      ["onlyAllowPaths", "仅同步这些路径", "填写后只同步匹配的路径；留空同步全部。每行一个正则表达式。"],
    ] as const) {
      let edited = (s[key] ?? []).join("\n");
      const setting = new Setting(body).setName(label).setDesc(desc);
      setting.settingEl.addClass("rs-textarea-setting");
      setting
        .addTextArea((ta) => {
          ta.setValue(edited).setPlaceholder("^Archive/\n\\.pdf$").onChange((v) => (edited = v));
          ta.inputEl.rows = 3;
        })
        .addButton((b) =>
          b.setButtonText("保存").onClick(() =>
            this.action(b, async () => {
              const patterns = edited.split("\n").map((x) => x.trim()).filter(Boolean);
              for (const p of patterns) {
                try { new RegExp(p); } catch { throw new Error(`正则表达式无效：${p}`); }
              }
              await this.save({ [key]: patterns });
              new Notice(`${label}已保存（${patterns.length} 条）。`);
            }, true)
          )
        );
    }
  }

  // ───────────────────────── helpers ─────────────────────────

  private avatarFallback(el: HTMLElement, name?: string) {
    el.empty();
    el.removeClass("has-photo");
    if (name?.trim()) el.setText(name.trim().charAt(0).toUpperCase());
    else setIcon(el, "user");
  }

  /** Shows the cached Microsoft avatar at once, then refreshes it weekly (or on click). Never blocks the page. */
  private async loadAvatar(el: HTMLElement, account: string, force = false) {
    const p = this.plugin;
    const show = (url: string) => {
      el.empty();
      el.addClass("has-photo");
      el.createEl("img", { attr: { src: url, alt: account || "账号头像" } });
    };
    try {
      const cached = await getCachedAvatarByVault(p.db, p.vaultRandomID);
      const sameAccount = cached?.account === account;
      if (sameAccount && cached?.dataUrl) show(cached.dataUrl);
      const fresh = sameAccount && Date.now() - (cached?.fetchedAt ?? 0) < 7 * 86400000;
      // A sync may be refreshing the token at the same time; keep the cached picture until it finishes.
      if ((fresh && !force) || p.isSyncing) return;
      const client = getClient(p.settings, this.app.vault.getName(), () => p.saveSettings()) as unknown as {
        getProfilePhoto?: () => Promise<{ data: ArrayBuffer; type: string } | undefined>;
      };
      if (!client.getProfilePhoto) return;
      const photo = await client.getProfilePhoto();
      const dataUrl = photo ? `data:${photo.type};base64,${arrayBufferToBase64(photo.data)}` : undefined;
      await upsertCachedAvatarByVault(p.db, p.vaultRandomID, { account, dataUrl, fetchedAt: Date.now() });
      if (!el.isConnected) return;
      if (dataUrl) show(dataUrl);
      else this.avatarFallback(el, account);
      if (force) new Notice(dataUrl ? "头像已更新。" : "这个微软账号没有设置头像。");
    } catch (error) {
      console.debug("remotely-save-local: avatar", error);
      if (force) new Notice(`无法读取头像：${(error as Error).message}`);
    }
  }

  private iconText(el: HTMLElement, icon: string, text: string) {
    setIcon(el.createSpan({ cls: "rs-btn-icon" }), icon);
    el.createSpan({ text });
  }

  private toggle(parent: HTMLElement, label: string, desc: string, value: boolean, save: (v: boolean) => Promise<void>) {
    return new Setting(parent)
      .setName(label)
      .setDesc(desc)
      .addToggle((t) => t.setValue(value).onChange((v) => this.action(t, () => save(v))));
  }

  private interval(parent: HTMLElement, label: string, desc: string, value: number | undefined, choices: number[], save: (v: number) => Promise<void>) {
    new Setting(parent)
      .setName(label)
      .setDesc(desc)
      .addDropdown((d) => {
        for (const n of new Set([...choices, value ?? -1].sort((a, b) => a - b))) d.addOption(String(n), intervalLabel(n));
        d.setValue(String(value ?? -1)).onChange((v) => this.action(d, () => save(Number(v))));
      });
  }

  private startStatusTimer() {
    this.stopStatusTimer();
    this.statusTimer = window.setInterval(() => this.renderStatus(), 1000);
  }

  private stopStatusTimer() {
    if (this.statusTimer !== undefined) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
  }
}

export class GitIgnoreModal extends Modal {
  constructor(app: App, readonly plugin: RemotelySavePlugin) {
    super(app);
  }

  async onOpen() {
    this.modalEl.addClass("rs-gitignore-modal");
    this.contentEl.createEl("h2", { text: "编辑根目录 .gitignore" });
    this.contentEl.createEl("p", { text: "每行一条 Git 忽略规则；匹配的文件不会上传、下载或被同步删除。规则只保存在本设备。" });
    try {
      const adapter = this.app.vault.adapter;
      const original = await adapter.exists(".gitignore") ? await adapter.read(".gitignore") : null;
      const editor = this.contentEl.createEl("textarea", { cls: "rs-gitignore-editor" });
      editor.value = original ?? "";
      editor.placeholder = "private/\n*.tmp\n!keep.tmp";
      new Setting(this.contentEl)
        .addButton(b => b.setButtonText("取消").onClick(() => this.close()))
        .addButton(b => b.setButtonText("保存").setCta().onClick(async () => {
          try {
            if (this.plugin.isSyncing) throw new Error("同步进行中，请完成后再保存规则。");
            await saveRootGitIgnore(adapter, original, editor.value);
            new Notice(".gitignore 已保存，下次同步时生效。");
            this.close();
          } catch (error) {
            new Notice((error as Error).message, 10000);
          }
        }));
    } catch (error) {
      this.contentEl.createEl("p", { text: `无法读取 .gitignore：${(error as Error).message}` });
    }
  }

  onClose() { this.contentEl.empty(); }
}

export class OnedriveAuthModal extends Modal {
  constructor(app: App, readonly plugin: RemotelySavePlugin) {
    super(app);
  }

  async onOpen() {
    this.contentEl.createEl("h2", { text: "连接 OneDrive" });
    try {
      const { authUrl, verifier, state } = await getAuthUrlAndVerifier(
        this.plugin.settings.onedrive.clientID,
        this.plugin.settings.onedrive.authority
      );
      await saveOneDriveAuthSession(this.plugin.db, this.plugin.vaultRandomID, verifier, state);
      this.plugin.oauth2Info.verifier = verifier;
      this.contentEl.createEl("p", {
        text: "在微软页面完成授权后返回 Obsidian。取消或失败不会清除现有账号。",
      });
      this.contentEl.createEl("a", { text: "打开 Microsoft 登录页面", href: authUrl });
    } catch (error) {
      this.contentEl.createEl("p", {
        text: `无法开始授权：${(error as Error).message}`,
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
