# Remotely Save (local fork)

English | [简体中文](README.zh-cn.md)

An Obsidian plugin that syncs your vault with Microsoft OneDrive, on desktop (macOS, Windows, Linux) and mobile (iOS, Android). It is a fork of the open-source [Remotely Save](https://github.com/remotely-save/remotely-save) (Apache-2.0) without the upstream paid/subscription parts, with a rewritten sync loop and stronger conflict and deletion safeguards. The plugin ID is `remotely-save-local`, so it can sit next to the original plugin in the same vault (never enable both at once). The interface is in Chinese.

## Install

**Recommended: BRAT (desktop and mobile, with automatic updates)**

1. Settings → Community plugins → turn off Restricted mode → Browse, install **BRAT** (Obsidian42 - BRAT).
2. BRAT settings → **Add Beta plugin** → enter `wzp100/remotely-save` → pick the latest version.
3. If the original Remotely Save is installed, disable it first, then enable **Remotely Save 本地版**.
4. Open the plugin settings. If the account card shows your account you are done; otherwise sign in to OneDrive. Use the **same remote folder name** on every device.
5. Before the first sync, run a **preview** (预览) and check that nothing unexpected will be deleted, then sync (立即同步).

**Manual**: download `main.js`, `manifest.json` and `styles.css` from [Releases](https://github.com/wzp100/remotely-save/releases/latest) into `<vault>/.obsidian/plugins/remotely-save-local/`.

**Updates**: BRAT checks on every Obsidian start; the plugin's "版本与更新" (version & updates) card can also check and update. With program-file sync on, one updated device delivers the new version to the others through OneDrive; reload the plugin or restart Obsidian to run it. Do not "Add" this plugin again in BRAT once installed—that can reinstall an older version.

## Features

- **Status dashboard**: state, progress and current file, last result (uploads / downloads / deletions / conflicts), an expandable list of operations, errors, plus *sync now* and *preview*.
- **Automatic sync**: on an interval, after startup, after edits, and **when Obsidian returns to the foreground** (after being away for over a minute, e.g. a phone resuming).
- **Incremental listing**: only asks OneDrive for changes since the last sync, so a sync without changes takes seconds. Paths are rebuilt from the item-id chain; any inconsistency falls back to a full listing, and a full listing is forced every 24 hours.
- **Conflicts never lose content**: when both sides changed, the configured winner (newer or larger) is kept and the overwritten note is saved as `name (冲突 本机|云端 date time).ext` and synced everywhere. Overwritten `.obsidian` config files are backed up on the device under `.obsidian/plugins/remotely-save-local/conflict-backups/` and cleaned after 30 days. "Conflicts" with identical content are only recorded.
- **Deletion guard**: stops when more than a threshold (default 50%) of files would be overwritten or deleted. Files that differ only in timestamps do not count, so a new device with the same notes is not blocked.
- **Folder deletions**: a folder deleted on one side is removed on the other only if it is **completely empty** right then, including hidden files the sync never lists.
- **Files edited mid-sync** (e.g. a plugin saving its settings) are skipped until the next sync instead of aborting the whole run.
- **Empty notes**: OneDrive cannot store empty files; they are listed in the result and uploaded once they have content.
- **Version & updates**: running version, latest GitHub release and notes, the version in the cloud, update channels and runtime.
- **Also**: respects `.gitignore`, ignore / allow-only path regexes, sync direction, concurrency, encryption (rclone or OpenSSL format), Microsoft account photo. Follows the Obsidian theme and switches to one column on narrow screens.

## Privacy

- Each device keeps its own OneDrive authorization and plugin settings (`data.json`); they are never synced.
- Sync history, the listing snapshot and the avatar cache stay in the device's IndexedDB.
- Without an encryption password, notes are stored in OneDrive as plain files (transferred over HTTPS).

## Migrating from the original Remotely Save

On first start without its own `data.json`, the plugin copies settings and authorization from the original plugin on the same device, leaving the original files untouched. Both plugins share the OneDrive callback, so keep the original disabled. The original plugin does not protect its own `data.json`; do not migrate by turning on its config-folder sync.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run build   # needs .env, see .env.example.txt
```

GitHub Actions tests and builds every push. To release: bump the version in `manifest.json`, `package.json` and `versions.json`, optionally add `release-notes/<version>.md`, then `git tag <version> && git push origin <version>`. The workflow builds the release from that tag and keeps only the latest release.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The upstream `pro/` directory (PolyForm Strict) is not included; third-party dependencies keep their own open-source licenses.
