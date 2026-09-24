import type { LibraryCall } from "./library-panel.js";
import type { LibraryAsset } from "./library-types.js";
import type { GitHubDirectory, GitHubRepo } from "./github-types.js";

export function createGithubPanel(container: HTMLElement, call: LibraryCall, refreshLibrary: () => Promise<void>, openAsset: (id: string) => Promise<void>) {
  container.innerHTML = `<details><summary>从 GitHub 找资料</summary>
    <p id="github-account" role="status"></p><button id="github-account-refresh" type="button">刷新账号</button>
    <p class="library-note">公共仓库可直接阅读。收藏及私有仓库请先在本机终端执行 <code>gh auth login --hostname github.com</code>，完成浏览器授权后刷新账号。</p>
    <form id="github-open"><label>仓库链接或 owner/repo<input id="github-repository" placeholder="例如 modelcontextprotocol/ext-apps" required></label>
    <label>分支、标签或提交（留空使用默认分支）<input id="github-ref" placeholder="例如 main"></label><button>打开仓库</button></form>
    <form id="github-search"><label>搜索仓库<input id="github-query" placeholder="仓库名称或关键词" required></label><button>搜索</button></form>
    <div class="github-actions"><button id="github-starred" type="button">我的收藏</button><button id="github-mine" type="button">我的仓库</button></div>
    <p id="github-status" role="status" aria-live="polite"></p><ul id="github-repositories"></ul>
    <div class="github-actions"><button id="github-previous" type="button" hidden>上一页</button><button id="github-next" type="button" hidden>下一页</button></div>
    <p id="github-location"></p><button id="github-parent" type="button" hidden>上一级目录</button><ul id="github-files"></ul></details>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
  let current: GitHubDirectory | null = null, busy = false, kind: "search" | "starred" | "mine" = "search", query = "", page = 1;
  const status = el("github-status");
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    busy = true; status.textContent = "正在读取 GitHub…";
    container.setAttribute("aria-busy", "true");
    for (const b of container.querySelectorAll("button")) b.disabled = true;
    try { await fn(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { busy = false; container.removeAttribute("aria-busy"); for (const b of container.querySelectorAll("button")) b.disabled = b.dataset.unsupported === "true"; }
  }
  async function account() {
    const data = await call<{ connected: boolean; login: string | null }>("github_account", {});
    el("github-account").textContent = data.connected ? `已连接：${data.login}` : "未登录 · 可浏览公共仓库";
  }
  async function directory(repository: string, commit: string, path = "") {
    const data = await call<GitHubDirectory>("github_directory", { repository, commit, path });
    current = data;
    el("github-location").textContent = `${data.repository} · ${commit.slice(0, 12)} · /${path}`;
    el("github-parent").hidden = !path;
    el("github-files").replaceChildren();
    const entries = [...data.entries].sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
    for (const entry of entries) {
      const li = document.createElement("li"), button = document.createElement("button"); button.type = "button";
      button.textContent = `${entry.type === "dir" ? "目录 · " : ""}${entry.name}${entry.type === "unsupported" ? "（链接／子模块，暂不支持）" : ""}`;
      button.disabled = entry.type === "unsupported"; button.dataset.unsupported = String(button.disabled);
      button.addEventListener("click", () => void action(async () => {
        if (entry.type === "dir") await directory(repository, commit, entry.path);
        else {
          status.textContent = `正在下载并校验 ${entry.name}…`;
          const asset = await call<LibraryAsset>("github_import_file", { repository, commit, path: entry.path });
          await refreshLibrary(); status.textContent = `已入库：${entry.name} · ${commit.slice(0, 12)}`;
          await openAsset(asset.assetId);
        }
      })); li.append(button); el("github-files").append(li);
    }
    status.textContent = entries.length ? `${entries.length} 项 · 点击文件入库并阅读` : "此目录为空。";
  }
  async function open(repository: string, ref?: string) {
    const resolved = await call<{ repository: string; commit: string }>("github_resolve", { repository, ...(ref ? { ref } : {}) });
    el<HTMLInputElement>("github-repository").value = resolved.repository;
    el<HTMLInputElement>("github-ref").value = ref ?? "";
    await directory(resolved.repository, resolved.commit);
  }
  async function repositories(nextKind = kind, nextPage = page, nextQuery = query) {
    const data = await call<{ repositories: GitHubRepo[]; hasMore: boolean }>("github_repositories", { kind: nextKind, query: nextQuery, page: nextPage });
    kind = nextKind; page = nextPage; query = nextQuery;
    el("github-repositories").replaceChildren();
    for (const repo of data.repositories) {
      const li = document.createElement("li"), button = document.createElement("button"), description = document.createElement("p");
      li.className = "library-item"; button.type = "button";
      button.textContent = repo.fullName + (repo.private ? " · 私有" : ""); description.textContent = repo.description;
      button.addEventListener("click", () => void action(() => open(repo.fullName)));
      li.append(button, description); el("github-repositories").append(li);
    }
    el("github-previous").hidden = page === 1; el("github-next").hidden = !data.hasMore || page >= 100;
    status.textContent = data.repositories.length ? `第 ${page} 页 · ${data.repositories.length} 个仓库` : "没有找到仓库。";
  }
  el("github-open").addEventListener("submit", e => { e.preventDefault(); void action(() => open(el<HTMLInputElement>("github-repository").value, el<HTMLInputElement>("github-ref").value.trim())); });
  el("github-search").addEventListener("submit", e => { e.preventDefault(); void action(() => repositories("search", 1, el<HTMLInputElement>("github-query").value)); });
  el("github-starred").addEventListener("click", () => void action(() => repositories("starred", 1)));
  el("github-mine").addEventListener("click", () => void action(() => repositories("mine", 1)));
  el("github-previous").addEventListener("click", () => void action(() => repositories(kind, page - 1)));
  el("github-next").addEventListener("click", () => void action(() => repositories(kind, page + 1)));
  el("github-parent").addEventListener("click", () => { if (current) void action(() => directory(current!.repository, current!.commit, current!.path.split("/").slice(0, -1).join("/"))); });
  el("github-account-refresh").addEventListener("click", () => void action(async () => { await account(); status.textContent = "账号状态已刷新。"; }));
  return { async show(enabled: boolean) {
    container.hidden = !enabled;
    if (enabled) try { await account(); } catch (error) { el("github-account").textContent = error instanceof Error ? error.message : String(error); }
  } };
}
