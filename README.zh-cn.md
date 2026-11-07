# Remotely Save 本地版 0.7.2

集成同步控制台的桌面和移动端 Obsidian 插件，主要使用 Microsoft OneDrive 应用目录。独立插件 ID 为 `remotely-save-local`，首次启用时可从同一设备上的旧版 `remotely-save` 读取设置和 OneDrive 授权。

设置页提供：实时同步状态、当前进度、正在处理的文件、最近一次结果与错误、手动同步、预览、连接检查、账号状态、自动/启动/保存后同步、方向、冲突策略、修改保护、配置与书签同步、忽略和允许路径、并发设置。没有订阅账号、网站登录或付费服务入口。其他基础服务的已保存配置继续保留。

## 安装与升级

将安装包中的 main.js、manifest.json、styles.css 放到笔记库 `.obsidian/plugins/remotely-save-local/`。先停用旧版 Remotely Save，再启用本地版：新插件没有自己的 `data.json` 时，会从本机旧插件复制设置并保存到自己的目录，原文件不会被覆盖。不要在不同设备间复制 `data.json`；每台设备都从自己的旧插件迁移或单独登录。

新旧插件共用 OneDrive 的授权回调和同步目标，不能同时启用。即使插件 ID 不同，上游旧版也可能同步其他插件的 `data.json`，因此迁移完成后请保持旧版停用。

## 实现与数据兼容

- 沿用上游 Apache-2.0 的本地、云端、加密驱动与配置编码。
- 基础同步主循环独立实现，使用原数据库和 vault ID；从此前本地版迁移时继续使用原历史，从上游旧版迁移时隔离同步历史，避免错误推断删除。
- 按两端历史处理新增、编辑、删除和冲突；成功传输后逐项保存历史；失败会等待正在执行的操作结束并停止新任务。
- 完全排除上游 pro 目录及其账户、付费服务、智能合并模块和服务请求。原 pro 账户与停用服务字段在加载时清除；OneDrive 等基础字段不改动。
- OneDrive 继续使用原 client ID、应用目录权限和授权回调。过期时间按秒换算毫秒，刷新响应未轮换 refresh token 时保留原值。
- 增量列表按条目 ID 去重，以最后一次结果为准，排除删除标记。规范：[Microsoft Graph delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta)。
- 不递归删除文件夹，避免误删不在同步范围内的内容；已经清空的目录可能保留。
- 启用“同步本地版程序文件”后，自身插件只同步 `main.js`、`manifest.json`、`styles.css`；自身 `data.json` 和其他私有文件始终排除，旧版 `remotely-save` 的整个目录也不参与同步。程序文件按版本成组同步，不用旧版本覆盖新版本，同版本冲突时停止覆盖；workspace.json、独立控制台和内部调试目录不参与同步。
- 每台设备的本插件授权与设置独立保存。已经运行旧版的其他设备需先安装本地版，才能遵守这条规则；新设备需要单独完成 OneDrive 登录。
- 仅测试了当前 macOS Obsidian 和 OneDrive；其他基础网盘没有进行新的端到端实测。

在手机上从旧版迁移时，保留原来的 `.obsidian/plugins/remotely-save/data.json`，让本地版在该设备上读取一次。各设备在“连接与授权”里填写相同的“OneDrive 远程目录”（留空时使用各自的笔记库名称），并使用各自的授权。“同步本地版程序文件”独立于“同步 Obsidian 配置”，默认启用，可经 OneDrive 同步这三个程序文件，无需同步其他设置。

旧版 Remotely Save 不会自动保护自己的 `data.json`；不要在旧版中直接开启配置同步来迁移，否则可能覆盖或上传设备授权。

如需用上游旧版在手机上首次接收本地版程序，可以临时限定它的同步范围（以下针对默认的 `.obsidian` 目录）：

1. 暂时关闭旧版的“同步配置文件夹”，记下它原来是否开启。在旧版“忽略的文件或文件夹的正则表达式”末尾追加下面第一行；如果配置同步原来关闭，也追加第二行。保留原有规则。

   ```text
   ^(?!\.obsidian/(?:plugins/(?:remotely-save-local/(?:main\.js|styles\.css|manifest\.json)?)?)?$)
   ^(?!)rs-local-config-was-off$
   ```

2. 如果旧版的“允许同步的文件或文件夹的正则表达式”不为空，保留原有内容，并追加：

   ```text
   ^\.obsidian/(?:plugins/(?:remotely-save-local/(?:main\.js|styles\.css|manifest\.json)?)?)?$
   ```

3. 在旧版临时开启配置同步，先预览并确认只下载本地版的三个程序文件及相关目录，再执行同步。若预览出现其他文件或未出现预期下载，停止并检查已有规则与同步方向。
4. 停用旧版并启用本地版。本地版会在本机继承旧授权、移除上述临时规则；如果原先配置同步关闭，也会恢复关闭。之后程序文件通过独立开关同步。

## .gitignore

设置中的“遵循 .gitignore”默认启用，会读取本设备笔记库根目录和子目录的 `.gitignore`。根目录规则可以直接在设置页编辑，子目录规则可使用其他工具编辑。规则按 Git 语法匹配，支持目录、通配符、`!` 例外和嵌套规则。匹配的路径不上传、不下载，也不会因规则被删除；已存在的云端文件不会因此清除。规则文件本身不自动同步，每台设备需要自行配置。

例如：

```gitignore
private/
*.tmp
!keep.tmp
```

## 构建与测试

Node.js + npm：`npm ci --ignore-scripts`、`npm test`、`npm run build`。`.env` 只包含公开 OAuth client ID/authority，按 `.env.example.txt` 配置。安装包不含 .env 或个人 data.json。

`validation/` 保存测试、构建和 OneDrive 隔离测试结果。构建元数据 build-meta.json 可核对无 pro 输入。

升级前备份在笔记库外 `../.remotely-backups/`，包含旧插件及原配置，请勿公开其中的账号数据。

## 许可证

本地 fork 源码按 Apache-2.0 发布。上游 `pro/` 的 PolyForm Strict 源码、二进制和运行时依赖均未包含在仓库中；第三方 npm 依赖继续使用各自的开源许可证（包括 MIT、Apache-2.0、ISC、BSD 等）。`build-meta.json` 是本机构建输出，包含绝对路径，因此不提交到仓库。
