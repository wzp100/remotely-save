# Remotely Save 本地版 0.6.1

集成同步控制台的桌面版 Obsidian 插件，主要使用 Microsoft OneDrive 应用目录。沿用插件 ID `remotely-save`，现有 data.json、OneDrive 微软账号授权、本地数据库和同步历史继续使用。

设置页提供：实时同步状态、当前进度、正在处理的文件、最近一次结果与错误、手动同步、预览、连接检查、账号状态、自动/启动/保存后同步、方向、冲突策略、修改保护、配置与书签同步、忽略和允许路径、并发设置。没有订阅账号、网站登录或付费服务入口。其他基础服务的已保存配置继续保留。

## 安装与升级

将安装包中的 main.js、manifest.json、styles.css 放到笔记库 `.obsidian/plugins/remotely-save/`，保留原 data.json，再启用或重载插件。已在当前笔记库安装。独立的 remotely-save-console 已合并，可移除。

## 实现与数据兼容

- 沿用上游 Apache-2.0 的本地、云端、加密驱动与配置编码。
- 基础同步主循环独立实现，使用原数据库、vault ID 和 `onedrive-default-1` 历史命名空间。
- 按两端历史处理新增、编辑、删除和冲突；成功传输后逐项保存历史；失败会等待正在执行的操作结束并停止新任务。
- 完全排除上游 pro 目录及其账户、付费服务、智能合并模块和服务请求。原 pro 账户与停用服务字段在加载时清除；OneDrive 等基础字段不改动。
- OneDrive 继续使用原 client ID、应用目录权限和授权回调。过期时间按秒换算毫秒，刷新响应未轮换 refresh token 时保留原值。
- 增量列表按条目 ID 去重，以最后一次结果为准，排除删除标记。规范：[Microsoft Graph delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta)。
- 不递归删除文件夹，避免误删不在同步范围内的内容；已经清空的目录可能保留。
- 同步配置时排除自身插件和已经合并的独立控制台，防止云端旧代码覆盖当前插件；workspace.json 和内部调试目录也不参与同步。
- 仅测试了当前 macOS Obsidian 和 OneDrive；其他基础网盘没有进行新的端到端实测。

## 构建与测试

Node.js + npm：`npm ci --ignore-scripts`、`npm test`、`npm run build`。`.env` 只包含公开 OAuth client ID/authority，按 `.env.example.txt` 配置。安装包不含 .env 或个人 data.json。

`validation/` 保存测试、构建和 OneDrive 隔离测试结果。构建元数据 build-meta.json 可核对无 pro 输入。

升级前备份在笔记库外 `../.remotely-backups/`，包含旧插件及原配置，请勿公开其中的账号数据。

## 许可证

本地 fork 源码按 Apache-2.0 发布。上游 `pro/` 的 PolyForm Strict 源码、二进制和运行时依赖均未包含在仓库中；第三方 npm 依赖继续使用各自的开源许可证（包括 MIT、Apache-2.0、ISC、BSD 等）。`build-meta.json` 是本机构建输出，包含绝对路径，因此不提交到仓库。
