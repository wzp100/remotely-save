# Remotely Save 本地版

[English](README.md) | 简体中文

用 Microsoft OneDrive 同步 Obsidian 笔记库的插件，支持电脑（macOS、Windows、Linux）和手机（iOS、Android）。基于开源的 [Remotely Save](https://github.com/remotely-save/remotely-save)（Apache-2.0）修改，去掉了上游的付费 / 订阅部分，重写了同步主循环，并加强了冲突与删除保护。插件 ID 为 `remotely-save-local`，可以和旧版共存于同一个库（但不能同时启用）。

## 安装

**推荐：BRAT（电脑、手机都适用，可自动更新）**

1. 设置 → 第三方插件 → 关闭安全模式 → 浏览，搜索并安装 **BRAT**（Obsidian42 - BRAT）。
2. BRAT 设置 → **Add Beta plugin** → 输入 `wzp100/remotely-save` → 选最新版本。
3. 如果装过旧版 Remotely Save，先停用它，再启用 **Remotely Save 本地版**。
4. 打开插件设置：“账号与连接”里已显示账号即可直接使用，否则点“登录 OneDrive”。**远程目录**在所有设备上填写相同的名称。
5. 第一次同步前先点 **预览**，确认没有大量删除，再点 **立即同步**。

**手动安装**：从 [Releases](https://github.com/wzp100/remotely-save/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`，放到 `你的库/.obsidian/plugins/remotely-save-local/`。

**更新**：BRAT 在 Obsidian 启动时自动检查；也可以在插件设置的“版本与更新”里点“检查更新 / 更新”。开启“本插件程序”同步时，一台设备更新后，其他设备会通过 OneDrive 收到新版本，点“重载插件”或重启 Obsidian 生效。已安装后不要在 BRAT 里重复“添加”本插件（可能装成旧版本）。

## 主要功能

- **状态面板**：当前状态、进度与正在处理的文件、上次结果（上传 / 下载 / 删除 / 冲突）、可展开的操作清单、错误原因，“立即同步”和“预览”。
- **自动同步**：定时、启动后、保存后，以及**回到 Obsidian 时**（离开超过 1 分钟后切回，例如手机从后台回来）。
- **增量同步**：只向 OneDrive 请求上次以来的变化，没有改动时同步只需几秒。路径按条目 ID 链重建，任何不一致都会自动退回完整列表，每 24 小时强制完整列表一次。
- **冲突不丢内容**：两端都改过时按策略（较新 / 较大）保留一方，被替换的笔记另存为 `原名 (冲突 本机|云端 日期 时间).扩展名` 并同步到所有设备；`.obsidian` 配置文件的旧版本备份在本设备的 `.obsidian/plugins/remotely-save-local/conflict-backups/`，30 天后自动清理。内容其实相同的“冲突”只记录，不传输。
- **删除保护**：一次覆盖或删除的文件超过阈值（默认 50%）时停止同步；内容相同只是时间不同的文件不计入，新设备首次同步不会被误拦。
- **文件夹删除**：一端删除的文件夹，只有在另一端此刻**完全为空**（包括同步不列出的隐藏文件）时才删除，否则保留。
- **同步中被修改的文件**：例如插件正在写入设置，只跳过该文件，下次同步处理，不中断整轮同步。
- **空笔记**：OneDrive 不能保存空文件，空笔记会列在结果里，写入内容后自动上传。
- **版本与更新**：显示正在运行的版本、GitHub 最新发布与更新说明、云端程序版本、更新方式和运行环境。
- **其他**：遵循 `.gitignore`、忽略 / 仅允许路径（正则）、同步方向、并发数、加密（rclone / OpenSSL 格式）、微软账号头像。界面跟随 Obsidian 主题，手机窄屏自动单列。

## 隐私与数据

- 每台设备的 OneDrive 授权与插件设置（`data.json`）只保存在本设备，从不同步。
- 同步历史、增量列表快照、头像缓存保存在本设备的 IndexedDB。
- 未设置加密密码时，OneDrive 上的笔记是明文（传输使用 HTTPS）。

## 从旧版 Remotely Save 迁移

本地版首次启用且自己还没有 `data.json` 时，会从同一设备的旧版插件复制设置和授权（不修改旧文件）。新旧插件共用 OneDrive 授权回调，不能同时启用；迁移后保持旧版停用。旧版不会保护自己的 `data.json`，不要在旧版里开启配置同步来迁移。

## 开发

```sh
npm ci --ignore-scripts
npm test
npm run build   # 需要 .env，见 .env.example.txt
```

推送代码时 GitHub Actions 自动测试和构建。发布新版本：修改 `manifest.json`、`package.json`、`versions.json` 中的版本号，可选写 `release-notes/<版本>.md`，然后 `git tag <版本> && git push origin <版本>`，Actions 会从该标签的源码构建并发布，只保留最新一个发布。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。上游 `pro/` 目录（PolyForm Strict）未包含在内；第三方依赖沿用各自的开源许可证。
