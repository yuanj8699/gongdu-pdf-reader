import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LibraryService } from "./library.js";
import type { GitHubDirectory, GitHubRepo, GitHubSource } from "./src/github-types.js";

const run = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const repoSchema = z.object({ full_name: z.string(), description: z.string().nullable(), private: z.boolean(), default_branch: z.string() });
const treeSchema = z.object({ truncated: z.boolean().optional(), tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string().regex(SHA), size: z.number().optional() })) });

export function repositoryName(input: string): string {
  let name = input.trim();
  if (name.includes("://")) {
    const url = new URL(name);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash) throw new Error("请输入 github.com 仓库首页链接或 owner/repo。");
    name = url.pathname.replace(/^\/+|\/+$/g, "");
  }
  name = name.replace(/\.git$/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(name) || [".", ".."].includes(name.split("/")[1])) throw new Error("请输入仓库首页链接或 owner/repo；分支和文件路径请分别填写。");
  return name;
}
function segments(filePath: string) {
  if (filePath === "") return [];
  const parts = filePath.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[\\\x00-\x1f]/.test(p))) throw new Error("无效的仓库文件路径。");
  return parts;
}
export async function githubCredential(): Promise<string | undefined> {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) return token;
  try {
    const result = await run("gh", ["auth", "token", "--hostname", "github.com"], { windowsHide: true, timeout: 10000, maxBuffer: 16384 });
    return result.stdout.trim() || undefined;
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code === "ENOENT" || code === 1) return undefined;
    // Subprocess errors contain stdout/stderr and may contain credentials. Never propagate them.
    throw new Error("无法读取 GitHub CLI 授权，请在终端检查 gh auth status。");
  }
}

/** Read-only GitHub API. Credentials only travel to api.github.com; redirects are never followed. */
export class GitHubClient {
  constructor(private fetcher: typeof fetch = fetch, private credential = githubCredential) {}
  private async request(endpoint: string, raw = false, authRequired = false) {
    const token = await this.credential();
    if (authRequired && !token) throw new Error("请先在本机终端运行 gh auth login --hostname github.com，然后点击刷新账号。");
    let response: Response;
    try {
      response = await this.fetcher(`https://api.github.com${endpoint}`, {
        headers: { Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "GongduReader", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        redirect: "manual", signal: AbortSignal.timeout(raw ? 120000 : 30000),
      });
    } catch { throw new Error("GitHub 网络请求失败或超时，请检查网络后重试。"); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new Error("GitHub 授权已失效，请在终端重新执行 gh auth login；本机书库仍可阅读。");
      if (response.status === 429 || response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") throw new Error("GitHub 请求次数受限，请稍后重试；登录后可提高公开读取额度。");
      if (response.status === 403) throw new Error("GitHub 拒绝访问，请检查账号、仓库读取权限或组织 SSO 授权。");
      if (response.status === 404) throw new Error("未找到仓库、版本或文件；私有仓库请确认本机账号具有读取权限。");
      if (response.status >= 300 && response.status < 400) throw new Error("GitHub 地址已迁移，请使用仓库当前地址重新打开。");
      throw new Error(`GitHub 请求失败（HTTP ${response.status}）。`);
    }
    return response;
  }
  private async json(endpoint: string, authRequired = false): Promise<unknown> {
    const bytes = await this.bytes(await this.request(endpoint, false, authRequired), 8 * 1024 * 1024);
    try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("GitHub 返回了无法识别的数据。"); }
  }
  private async bytes(response: Response, limit: number): Promise<Buffer> {
    const chunks: Uint8Array[] = []; let size = 0;
    if (!response.body) throw new Error("GitHub 返回了空响应。");
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > limit) throw new Error("文件超出读取上限：PDF 100 MB，文本 1 MB。");
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    } finally { await reader.cancel(); }
  }
  async account() {
    if (!await this.credential()) return { connected: false, login: null };
    const user = z.object({ login: z.string() }).parse(await this.json("/user", true));
    return { connected: true, login: user.login };
  }
  async repositories(kind: "search" | "starred" | "mine", query = "", page = 1): Promise<{ repositories: GitHubRepo[]; hasMore: boolean }> {
    if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error("无效的结果页码。");
    if (kind === "search" && !query.trim()) throw new Error("请输入仓库搜索关键词。");
    const paging = `per_page=20&page=${page}`;
    const data = await this.json(kind === "search" ? `/search/repositories?q=${encodeURIComponent(query.trim())}&${paging}` : kind === "starred" ? `/user/starred?sort=updated&${paging}` : `/user/repos?sort=updated&${paging}`, kind !== "search");
    const rows = kind === "search" ? z.object({ items: z.array(repoSchema) }).parse(data).items : z.array(repoSchema).parse(data);
    return { repositories: rows.map(r => ({ fullName: r.full_name, description: r.description ?? "", private: r.private, defaultBranch: r.default_branch })), hasMore: rows.length === 20 };
  }
  async resolve(repository: string, ref?: string) {
    const name = repositoryName(repository);
    const repo = repoSchema.parse(await this.json(`/repos/${name}`));
    const commit = z.object({ sha: z.string().regex(SHA) }).parse(await this.json(`/repos/${name}/commits/${encodeURIComponent(ref?.trim() || repo.default_branch)}`));
    return { repository: repositoryName(repo.full_name), commit: commit.sha };
  }
  private async tree(repository: string, sha: string) {
    const data = treeSchema.parse(await this.json(`/repos/${repository}/git/trees/${sha}`));
    if (data.truncated) throw new Error("此目录超过 GitHub 返回上限，未展示不完整结果。");
    return data.tree;
  }
  private async directoryTree(repository: string, commit: string, filePath: string) {
    if (!SHA.test(commit)) throw new Error("请先打开仓库，取得确定的提交版本。");
    let tree = await this.tree(repositoryName(repository), commit);
    for (const part of segments(filePath)) {
      const entry = tree.find(e => e.path === part && e.type === "tree");
      if (!entry) throw new Error("此提交中没有该目录。");
      tree = await this.tree(repository, entry.sha);
    }
    return tree;
  }
  async directory(repository: string, commit: string, filePath = ""): Promise<GitHubDirectory> {
    repository = repositoryName(repository);
    const tree = await this.directoryTree(repository, commit, filePath);
    return { repository, commit, path: filePath, entries: tree.map(e => ({ name: e.path, path: filePath ? `${filePath}/${e.path}` : e.path,
      type: e.type === "tree" ? "dir" : e.type === "blob" && /^100/.test(e.mode) ? "file" : "unsupported", size: e.size })) };
  }
  async file(repository: string, commit: string, filePath: string): Promise<{ bytes: Buffer; source: GitHubSource }> {
    repository = repositoryName(repository);
    const parts = segments(filePath), name = parts.pop();
    if (!name) throw new Error("请选择文件。");
    const tree = await this.directoryTree(repository, commit, parts.join("/"));
    const entry = tree.find(e => e.path === name);
    if (!entry || entry.type !== "blob" || !/^100/.test(entry.mode)) throw new Error("仅支持仓库内的普通文件；不读取符号链接或子模块。");
    const format = /\.pdf$/i.test(name) ? "pdf" : /\.(md|markdown|mdown)$/i.test(name) ? "markdown" : "code";
    const limit = format === "pdf" ? 100 * 1024 * 1024 : 1024 * 1024;
    if ((entry.size ?? 0) > limit) throw new Error("文件超出读取上限：PDF 100 MB，文本 1 MB。");
    const bytes = await this.bytes(await this.request(`/repos/${repository}/git/blobs/${entry.sha}`, true), limit);
    const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (hash !== entry.sha || entry.size !== undefined && entry.size !== bytes.length) throw new Error("GitHub 文件校验失败，未保存。");
    if (bytes.subarray(0, 100).toString().startsWith("version https://git-lfs.github.com/spec/v1")) throw new Error("这是 Git LFS 指针，请下载原文件后从本地导入。");
    if (format !== "pdf") {
      let decoded: string;
      try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("仅支持 UTF-8 文本、代码和 Markdown。"); }
      if (bytes.includes(0)) throw new Error("此文件是二进制内容，无法作为文本阅读。");
      if (decoded.split("\n").length > 10000) throw new Error("文本超过 10000 行，请在 GitHub 原文中阅读。");
    }
    return { bytes, source: { provider: "github", repository, commit, path: filePath, blobSha: entry.sha, format,
      url: `https://github.com/${repository}/blob/${commit}/${segments(filePath).map(encodeURIComponent).join("/")}` } };
  }
}

export class GitHubService {
  constructor(readonly library: LibraryService, readonly client = new GitHubClient()) {}
  async importFile(repository: string, commit: string, filePath: string) {
    const { bytes, source } = await this.client.file(repository, commit, filePath);
    const staged = path.join(this.library.directory, "tmp", `${randomUUID()}.part`);
    await fs.writeFile(staged, bytes, { flag: "wx" });
    try { return await this.library.importGithub(staged, source); }
    finally { await fs.rm(staged, { force: true }); }
  }
}
