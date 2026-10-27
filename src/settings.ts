// Local fork: one integrated settings tab, adapted from the local console.
import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type RemotelySavePlugin from "./main";
import type {
  RemotelySavePluginSettings,
  SyncDirectionType,
  SyncTriggerSourceType,
} from "./baseTypes";
import { getClient } from "./fsGetter";
import { getAuthUrlAndVerifier } from "./fsOnedrive";
import {
  getLastFailedSyncTimeByVault,
  getLastSuccessSyncTimeByVault,
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

const OPERATION_LABELS: Record<string, string> = {
  upload: "上传",
  download: "下载",
  delete_local: "删除本地文件",
  delete_remote: "删除云端文件",
  mkdir_local: "创建本地文件夹",
  mkdir_remote: "创建云端文件夹",
  equal: "文件一致",
  forget: "清理同步记录",
  skip: "跳过",
};

const intervalLabel = (n?: number) =>
  !n || n < 0 ? "关闭" : n < 60000 ? `${n / 1000} 秒` : `${n / 60000} 分钟`;

const formatDuration = (milliseconds?: number) => {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "未知";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
};

const formatTime = (milliseconds?: number) =>
  milliseconds ? new Date(milliseconds).toLocaleString() : "暂无记录";

export class RemotelySaveSettingTab extends PluginSettingTab {
  private generation = 0;
  private statusTimer?: number;
  private statusBody?: HTMLElement;
  private heroStatus?: HTMLElement;
  private historySuccess?: HTMLElement;
  private historyFailure?: HTMLElement;

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

  async action(button: { setDisabled(v: boolean): unknown }, fn: () => Promise<unknown>) {
    button.setDisabled(true);
    try {
      await fn();
    } catch (error) {
      new Notice((error as Error).message, 10000);
    } finally {
      button.setDisabled(false);
      await this.display();
    }
  }

  async display() {
    this.stopStatusTimer();
    const generation = ++this.generation;
    const root = this.containerEl;
    root.empty();
    root.addClass("rs-console");

    const s = this.plugin.settings;
    const cloud = s[s.serviceType] as {
      remoteBaseDir?: string;
      username?: string;
      refreshToken?: string;
      accessToken?: string;
    };
    const hero = root.createDiv({ cls: "rs-hero" });
    hero.createEl("h1", { text: "笔记同步" });
    this.heroStatus = hero.createEl("p");

    const actions = hero.createDiv({ cls: "rs-actions" });
    new Setting(actions)
      .addButton((b) =>
        b
          .setButtonText("立即同步")
          .setCta()
          .setDisabled(this.plugin.isSyncing)
          .onClick(() => this.action(b, () => this.plugin.syncRun("manual")))
      )
      .addButton((b) =>
        b
          .setButtonText("预览同步")
          .setDisabled(this.plugin.isSyncing)
          .onClick(() => this.action(b, () => this.plugin.syncRun("dry")))
      )
      .addButton((b) =>
        b
          .setButtonText("检查连接")
          .setDisabled(this.plugin.isSyncing)
          .onClick(() =>
            this.action(b, async () => {
              await getClient(
                this.plugin.settings,
                this.app.vault.getName(),
                () => this.plugin.saveSettings()
              ).walkPartial();
              new Notice("连接成功，现有授权可用。");
            })
          )
      )
      .addButton((b) => b.setButtonText("刷新").onClick(() => this.display()));

    const liveCard = this.card(root, "同步情况");
    this.statusBody = liveCard.createDiv({ cls: "rs-live-body" });
    this.renderStatus();
    this.startStatusTimer();

    const connection = this.card(root, "连接与授权");
    this.row(connection, "同步服务", SERVICES[s.serviceType]);
    this.row(connection, "远程目录", cloud.remoteBaseDir || this.app.vault.getName());
    this.row(
      connection,
      "账号",
      cloud.username || (cloud.refreshToken || cloud.accessToken ? "已保存授权" : "尚未授权")
    );
    this.row(connection, "文件加密", s.password ? "已启用" : "未启用");
    if (s.serviceType === "onedrive") {
      connection.createEl("p", {
        text: "直接连接 Microsoft OneDrive 应用目录，使用已保存的微软账号授权。",
      });
      new Setting(connection)
        .setName("OneDrive 授权")
        .setDesc("现有授权继续使用；更换账号或授权失效时才需要重新登录。")
        .addButton((b) =>
          b.setButtonText(cloud.refreshToken ? "重新授权" : "登录 OneDrive").onClick(() => {
            const modal = new OnedriveAuthModal(this.app, this.plugin);
            this.plugin.oauth2Info.helperModal = modal;
            modal.open();
          })
        );
    }

    const timing = this.card(root, "同步节奏");
    this.interval(
      timing,
      "自动同步间隔",
      s.autoRunEveryMilliseconds,
      [-1, 60000, 300000, 600000, 900000, 1800000, 3600000],
      (n) => this.save({ autoRunEveryMilliseconds: n })
    );
    this.interval(
      timing,
      "启动后同步",
      s.initRunAfterMilliseconds,
      [-1, 1000, 5000, 10000, 30000, 60000],
      (n) => this.save({ initRunAfterMilliseconds: n })
    );
    this.interval(
      timing,
      "保存后同步",
      s.syncOnSaveAfterMilliseconds,
      [-1, 1000, 3000, 5000, 10000],
      (n) => this.save({ syncOnSaveAfterMilliseconds: n })
    );

    const rules = this.card(root, "同步规则");
    new Setting(rules)
      .setName("同步方向")
      .addDropdown((d) => {
        const choices: Record<SyncDirectionType, string> = {
          bidirectional: "双向同步",
          incremental_push_only: "仅上传，不传播删除",
          incremental_pull_only: "仅下载，不传播删除",
          incremental_push_and_delete_only: "上传并传播本地删除",
          incremental_pull_and_delete_only: "下载并传播云端删除",
        };
        for (const [key, label] of Object.entries(choices)) d.addOption(key, label);
        d.setValue(s.syncDirection ?? "bidirectional").onChange((v) =>
          this.action(d, () =>
            this.save({ syncDirection: v as SyncDirectionType })
          )
        );
      });
    new Setting(rules)
      .setName("冲突处理")
      .addDropdown((d) =>
        d
          .addOption("keep_newer", "保留较新的文件")
          .addOption("keep_larger", "保留较大的文件")
          .setValue(s.conflictAction ?? "keep_newer")
          .onChange((v) =>
            this.action(d, () =>
              this.save({ conflictAction: v as "keep_newer" | "keep_larger" })
            )
          )
      );
    new Setting(rules)
      .setName("修改保护")
      .setDesc("覆盖或删除比例超过阈值时停止同步；预览仍可使用。")
      .addDropdown((d) => {
        for (const n of new Set([10, 25, 50, 75, 100, s.protectModifyPercentage ?? 50]))
          d.addOption(String(n), `${n}%`);
        d.setValue(String(s.protectModifyPercentage ?? 50)).onChange((v) =>
          this.action(d, () =>
            this.save({ protectModifyPercentage: Number(v) })
          )
        );
      });
    this.toggle(rules, "同步 Obsidian 配置", !!s.syncConfigDir, (v) =>
      this.save({ syncConfigDir: v })
    );
    this.toggle(rules, "同步书签", !!s.syncBookmarks, (v) =>
      this.save({ syncBookmarks: v })
    );
    this.toggle(rules, "同步下划线开头的项目", !!s.syncUnderscoreItems, (v) =>
      this.save({ syncUnderscoreItems: v })
    );

    const advanced = root.createEl("details", { cls: "rs-section" });
    advanced.createEl("summary", { text: "高级设置" });
    new Setting(advanced)
      .setName("并发数")
      .addDropdown((d) => {
        for (const n of new Set([1, 2, 3, 5, 10, s.concurrency ?? 5]))
          d.addOption(String(n), String(n));
        d.setValue(String(s.concurrency ?? 5)).onChange((v) =>
          this.action(d, () => this.save({ concurrency: Number(v) }))
        );
      });
    for (const [key, label] of [
      ["ignorePaths", "忽略路径"],
      ["onlyAllowPaths", "仅允许的路径"],
    ] as const) {
      const draft = (s[key] ?? []).join("\n");
      let edited = draft;
      new Setting(advanced)
        .setName(label)
        .setDesc("每行一个正则表达式，空行忽略。")
        .addTextArea((t) => t.setValue(draft).onChange((v) => (edited = v)))
        .addButton((b) =>
          b.setButtonText("保存").onClick(() =>
            this.action(b, async () => {
              const patterns = edited
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean);
              for (const p of patterns) new RegExp(p);
              await this.save({ [key]: patterns });
            })
          )
        );
    }

    const history = this.card(root, "同步记录");
    const [success, failed] = await Promise.all([
      getLastSuccessSyncTimeByVault(this.plugin.db, this.plugin.vaultRandomID),
      getLastFailedSyncTimeByVault(this.plugin.db, this.plugin.vaultRandomID),
    ]);
    if (generation !== this.generation) return;
    this.historySuccess = this.row(history, "最近成功", formatTime(success ?? this.plugin.lastSyncSuccessAt));
    this.historyFailure = this.row(history, "最近失败", formatTime(failed ?? this.plugin.lastSyncFailureAt));
    this.renderStatus();
  }

  hide() {
    this.stopStatusTimer();
    this.statusBody = undefined;
    this.heroStatus = undefined;
    this.historySuccess = undefined;
    this.historyFailure = undefined;
    super.hide();
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

  private statusTitle() {
    const p = this.plugin;
    if (p.isSyncing) {
      return p.syncTriggerSource === "dry" ? "正在生成同步预览" : "正在同步";
    }
    if (p.syncPhase === "failed" || p.lastSyncError) return "上次同步失败";
    return "空闲";
  }

  private renderStatus() {
    const body = this.statusBody;
    if (!body) return;
    const p = this.plugin;
    const syncing = p.isSyncing;
    const failed = !syncing && (p.syncPhase === "failed" || !!p.lastSyncError);
    const state = syncing
      ? p.syncTriggerSource === "dry"
        ? "preview"
        : "syncing"
      : failed
        ? "failed"
        : "idle";
    const title = this.statusTitle();
    this.heroStatus?.setText(`${SERVICES[p.settings.serviceType]} · ${title}`);

    body.empty();
    const status = body.createDiv({ cls: `rs-live-state is-${state}` });
    const heading = status.createDiv({ cls: "rs-live-heading" });
    heading.createSpan({ cls: "rs-live-dot" });
    heading.createSpan({ cls: "rs-live-title", text: title });

    const elapsed = p.syncStartedAt ? Date.now() - p.syncStartedAt : p.lastSyncDurationMs;
    const source = p.syncTriggerSource ? SOURCE_LABELS[p.syncTriggerSource] : undefined;
    heading.createSpan({
      cls: "rs-live-meta",
      text: syncing
        ? [source, elapsed !== undefined ? `已用时 ${formatDuration(elapsed)}` : undefined]
            .filter(Boolean)
            .join(" · ")
        : [
            source,
            p.lastSyncFinishedAt ? `结束于 ${formatTime(p.lastSyncFinishedAt)}` : undefined,
            p.lastSyncDurationMs !== undefined
              ? `用时 ${formatDuration(p.lastSyncDurationMs)}`
              : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
    });

    if (syncing) {
      const progress = p.syncProgress;
      if (progress && progress.total > 0) {
        const percent = Math.min(100, Math.max(0, (progress.done * 100) / progress.total));
        const bar = status.createDiv({ cls: "rs-progress" });
        bar.createDiv({ cls: "rs-progress-fill" }).style.width = `${percent}%`;
        status.createDiv({
          cls: "rs-live-detail",
          text: `已处理 ${progress.done}/${progress.total} · ${percent.toFixed(1)}%`,
        });
        status.createDiv({
          cls: "rs-live-path",
          text: `${OPERATION_LABELS[progress.decision] ?? progress.decision} · ${progress.path}`,
        });
      } else {
        status.createDiv({
          cls: "rs-live-detail",
          text:
            p.syncTriggerSource === "dry"
              ? "正在读取并比对本地与云端文件，预览不会修改笔记或同步历史。"
              : "正在读取并比对本地与云端文件…",
        });
      }
    }

    const summary = p.lastSyncSummary;
    if (summary && !syncing) {
      const label = summary.dry ? "最近一次预览" : "最近一次同步";
      status.createDiv({
        cls: "rs-live-summary",
        text: `${label}：上传 ${summary.upload} · 下载 ${summary.download} · 删除本地 ${summary.deleteLocal} · 删除云端 ${summary.deleteRemote} · 文件夹 ${summary.folders} · 跳过 ${summary.skipped} · 冲突 ${summary.conflicts}`,
      });
      if (summary.actions.length === 0) {
        status.createDiv({ cls: "rs-live-detail", text: "没有需要传输的变化。" });
      } else {
        const details = status.createEl("details", { cls: "rs-live-actions" });
        details.createEl("summary", { text: `查看操作（${summary.actions.length} 项）` });
        details.createEl("pre", {
          text:
            summary.actions
              .slice(0, 200)
              .map((a) => `${OPERATION_LABELS[a.operation] ?? a.operation}  ${a.path}`)
              .join("\n") || "无需传输。",
        });
      }
    }

    if (p.lastSyncError) {
      status.createDiv({ cls: "rs-error", text: p.lastSyncError });
    }
    const times = status.createDiv({ cls: "rs-live-times" });
    times.createSpan({ text: `最近成功：${formatTime(p.lastSyncSuccessAt)}` });
    times.createSpan({ text: `最近失败：${formatTime(p.lastSyncFailureAt)}` });
    this.historySuccess?.setText(formatTime(p.lastSyncSuccessAt));
    this.historyFailure?.setText(formatTime(p.lastSyncFailureAt));
  }

  private card(parent: HTMLElement, title: string) {
    const card = parent.createDiv({ cls: "rs-section" });
    card.createEl("h2", { text: title });
    return card;
  }

  private row(parent: HTMLElement, label: string, value: string) {
    const row = parent.createDiv({ cls: "rs-key-value" });
    row.createSpan({ cls: "rs-label", text: label });
    return row.createSpan({ cls: "rs-value", text: value });
  }

  private toggle(
    parent: HTMLElement,
    label: string,
    value: boolean,
    save: (v: boolean) => Promise<void>
  ) {
    new Setting(parent)
      .setName(label)
      .addToggle((t) =>
        t.setValue(value).onChange((v) => this.action(t, () => save(v)))
      );
  }

  private interval(
    parent: HTMLElement,
    label: string,
    value: number | undefined,
    choices: number[],
    save: (v: number) => Promise<void>
  ) {
    new Setting(parent)
      .setName(label)
      .addDropdown((d) => {
        for (const n of new Set([...choices, value ?? -1]))
          d.addOption(String(n), intervalLabel(n));
        d.setValue(String(value ?? -1)).onChange((v) =>
          this.action(d, () => save(Number(v)))
        );
      });
  }
}

export class OnedriveAuthModal extends Modal {
  constructor(app: App, readonly plugin: RemotelySavePlugin) {
    super(app);
  }

  async onOpen() {
    this.contentEl.createEl("h2", { text: "连接 OneDrive" });
    try {
      const { authUrl, verifier } = await getAuthUrlAndVerifier(
        this.plugin.settings.onedrive.clientID,
        this.plugin.settings.onedrive.authority
      );
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
