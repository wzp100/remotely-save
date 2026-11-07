import ignore, { type Ignore } from "ignore";
import type { Entity } from "./baseTypes";

export interface GitIgnoreSource {
  directory: string;
  content: string;
}

type RuleSet = { directory: string; matcher: Ignore };

export class GitIgnoreFilter {
  private readonly rules: RuleSet[];

  constructor(sources: GitIgnoreSource[]) {
    this.rules = sources.map(({ directory, content }) => ({
      directory: directory ? `${directory.replace(/\/$/, "")}/` : "",
      matcher: ignore({ ignorecase: false }).add(content),
    })).sort((a, b) => a.directory.split("/").length - b.directory.split("/").length);
  }

  private matches(key: string): boolean {
    let excluded = false;
    for (const { directory, matcher } of this.rules) {
      if (!key.startsWith(directory) || key === directory) continue;
      const result = matcher.test(key.slice(directory.length));
      if (result.ignored) excluded = true;
      else if (result.unignored) excluded = false;
    }
    return excluded;
  }

  ignores(key: string): boolean {
    const parts = key.split("/").filter(Boolean);
    const folders = key.endsWith("/") ? parts.length : parts.length - 1;
    for (let i = 1; i <= folders; i++) {
      if (this.matches(`${parts.slice(0, i).join("/")}/`)) return true;
    }
    return !key.endsWith("/") && this.matches(key);
  }
}

export async function loadGitIgnore(
  adapter: { exists(path: string): Promise<boolean>; read(path: string): Promise<string> },
  localFiles: Entity[]
): Promise<GitIgnoreFilter> {
  const directories = new Set<string>([""]);
  for (const entity of localFiles) {
    const key = entity.key ?? entity.keyRaw;
    const parts = key.split("/").filter(Boolean);
    const count = key.endsWith("/") ? parts.length : parts.length - 1;
    for (let i = 1; i <= count; i++) directories.add(parts.slice(0, i).join("/"));
  }
  const pending = [...directories];
  const sources: GitIgnoreSource[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const directory = pending[cursor++];
      const file = directory ? `${directory}/.gitignore` : ".gitignore";
      try {
        if (await adapter.exists(file)) sources.push({ directory, content: await adapter.read(file) });
      } catch (error) {
        throw new Error(`无法读取 ${file}，为避免上传被忽略的文件已停止同步：${(error as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, worker));
  return new GitIgnoreFilter(sources);
}

export async function saveRootGitIgnore(
  adapter: { exists(path: string): Promise<boolean>; read(path: string): Promise<string>; write(path: string, data: string): Promise<void> },
  original: string | null,
  updated: string
): Promise<void> {
  const current = await adapter.exists(".gitignore") ? await adapter.read(".gitignore") : null;
  if (current !== original) throw new Error(".gitignore 已被其他程序修改，请重新打开后再保存。");
  await adapter.write(".gitignore", updated);
}
