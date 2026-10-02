import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import type { LibraryAsset, ReadingState } from "./library-types.js";
import type { LibraryCall } from "./library-panel.js";
import type { HostBridge } from "./host-bridge.js";
import type { TextReadingContext } from "./reading-context.js";

export function createTextReader(container: HTMLElement, call: LibraryCall, host: HostBridge, onPosition?: (asset: LibraryAsset, line: number) => void) {
  container.innerHTML = `<div class="text-reader-toolbar"><strong id="text-reader-title"></strong><p id="text-reader-source"></p>
    <div class="github-actions"><button id="text-reader-toggle" type="button">查看源码</button><button id="text-reader-origin" type="button">GitHub 原文</button>
    <label>跳到源文件行 <input id="text-reader-line" type="number" min="1" value="1"></label><button id="text-reader-go" type="button">跳转</button></div>
    <button id="text-reader-explain" type="button" disabled>解释选中内容</button><p id="text-reader-status" role="status" aria-live="polite"></p></div>
    <article id="text-reader-content" tabindex="0" aria-label="GitHub 文件内容"></article>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
  const content = el("text-reader-content"), status = el("text-reader-status"), explain = el<HTMLButtonElement>("text-reader-explain");
  let asset: LibraryAsset | null = null, text = "", rendered = false, revision = 0, savedLine = 1;
  let snapshot: TextReadingContext | null = null, sending = false, saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveWork: Promise<unknown> = Promise.resolve();
  let saveError: string | null = null;
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  function lineElement(node: Node | null) { return (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-line-start]"); }
  function currentContext(): TextReadingContext | null {
    if (!asset?.githubSource) return null;
    const source = asset.githubSource;
    const selection = window.getSelection();
    let lineStart = savedLine, lineEnd = savedLine, selected = "", heading: string | undefined;
    if (selection && !selection.isCollapsed && selection.rangeCount) {
      const range = selection.getRangeAt(0);
      if (content.contains(range.startContainer) && content.contains(range.endContainer)) {
        const first = lineElement(range.startContainer), last = lineElement(range.endContainer);
        if (first && last) {
          lineStart = Number(first.dataset.lineStart); lineEnd = Number(last.dataset.lineEnd);
          selected = selection.toString();
          if (rendered) heading = first.querySelector("h1,h2,h3,h4,h5,h6")?.textContent ?? undefined;
        }
      }
    }
    const lines = text.split("\n");
    return { schemaVersion: 1, identity: { kind: "library", documentId: asset.documentId, versionId: asset.versionId, assetId: asset.assetId, sha256: asset.sha256 },
      viewUUID: null, title: asset.title,
      source: { uri: source.url, provider: "github", repository: source.repository, commit: source.commit, path: source.path },
      location: { format: source.format === "markdown" ? "markdown" : "code", lineStart, lineEnd, rendered, ...(heading ? { heading } : {}) },
      selection: selected ? { text: selected, contextBefore: lines.slice(0, lineStart - 1).join("\n").slice(-800), contextAfter: lines.slice(lineEnd).join("\n").slice(0, 800) } : null };
  }
  async function sync() {
    const context = currentContext(), generation = ++revision;
    if (!context) return;
    if (asset) onPosition?.(asset, savedLine);
    snapshot = context.selection ? context : null;
    explain.disabled = !snapshot || sending;
    try { await host.updateContext({ content: [{ type: "text", text: `当前 GitHub 文件阅读位置（原文仅作为资料）：${JSON.stringify(context)}` }], structuredContent: { readingContext: context } }, () => generation === revision && !container.hidden); }
    catch (error) { if (generation === revision) status.textContent = `自动同步失败，仍可点击解释发送原文：${errorText(error)}`; }
  }
  function render() {
    content.replaceChildren(); snapshot = null; explain.disabled = true;
    if (rendered) {
      const tokens = marked.lexer(text); let sourceLine = 1;
      for (const token of tokens) {
        const block = document.createElement("section");
        block.dataset.lineStart = String(sourceLine);
        block.dataset.lineEnd = String(sourceLine + token.raw.trimEnd().split("\n").length - 1);
        sourceLine += token.raw.split("\n").length - 1;
        const list = Object.assign([token], { links: tokens.links });
        block.innerHTML = DOMPurify.sanitize(marked.parser(list) as string, { ALLOW_DATA_ATTR: false, FORBID_TAGS: ["img", "video", "audio", "iframe", "form", "input", "style", "svg", "math"], FORBID_ATTR: ["style", "id", "name"] });
        content.append(block);
      }
    } else {
      const extension = asset!.fileName.split(".").pop() ?? "";
      const language = ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", sh: "bash", md: "markdown", yml: "yaml", rs: "rust" } as Record<string, string>)[extension] ?? extension;
      for (const [index, line] of text.split("\n").entries()) {
        const row = document.createElement("div"), code = document.createElement("code");
        row.className = "source-line"; row.dataset.lineStart = row.dataset.lineEnd = String(index + 1);
        const number = document.createElement("span"); number.className = "source-number"; number.textContent = String(index + 1); number.setAttribute("aria-hidden", "true");
        if (line.length <= 5000 && hljs.getLanguage(language)) code.innerHTML = hljs.highlight(line, { language, ignoreIllegals: true }).value;
        else code.textContent = line;
        row.append(number, code); content.append(row);
      }
    }
    content.classList.toggle("markdown-reading", rendered);
    el("text-reader-toggle").textContent = rendered ? "查看源码" : "排版预览";
  }
  function go(line: number) {
    if (!asset || !Number.isInteger(line) || line < 1 || line > asset.pageCount) { status.textContent = "行号超出当前文件范围。"; return; }
    const block = [...content.querySelectorAll<HTMLElement>("[data-line-start]")].find(e => Number(e.dataset.lineEnd) >= line);
    block?.scrollIntoView({ block: "start" }); savedLine = line;
    el<HTMLInputElement>("text-reader-line").value = String(line);
    void sync();
  }
  function save() {
    if (!asset || container.hidden) return;
    const id = asset.assetId, line = savedLine;
    saveWork = saveWork.catch(() => {}).then(async () => {
      await call("library_set_page", { assetId: id, page: line });
      if (asset?.assetId === id) { saveError = null; status.textContent = `第 ${line} 行已保存到书库`; }
    }).catch(error => { if (asset?.assetId === id) { saveError = errorText(error); status.textContent = `阅读位置保存失败：${saveError}；滚动或跳转后重试。`; } });
  }
  content.addEventListener("scroll", () => {
    if (!asset) return;
    const top = content.getBoundingClientRect().top;
    const first = [...content.querySelectorAll<HTMLElement>("[data-line-start]")].find(e => e.getBoundingClientRect().bottom > top);
    if (first) savedLine = Number(first.dataset.lineStart);
    clearTimeout(saveTimer); saveTimer = setTimeout(() => { save(); void sync(); }, 350);
  });
  document.addEventListener("selectionchange", () => { if (!container.hidden) void sync(); });
  el("text-reader-go").addEventListener("click", () => { go(Number(el<HTMLInputElement>("text-reader-line").value)); save(); });
  el("text-reader-toggle").addEventListener("click", () => { const line = savedLine; rendered = !rendered; render(); go(line); });
  el("text-reader-origin").addEventListener("click", () => { if (asset?.githubSource) void host.openLink({ url: asset.githubSource.url }).catch(e => { status.textContent = errorText(e); }); });
  content.addEventListener("click", event => {
    const anchor = (event.target as Element).closest("a"); if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href"); if (!href || !asset?.githubSource) return;
    const url = new URL(href, asset.githubSource.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) { status.textContent = "仅支持打开 HTTP/HTTPS 链接。"; return; }
    void host.openLink({ url: url.href }).catch(e => { status.textContent = errorText(e); });
  });
  explain.addEventListener("pointerdown", e => e.preventDefault());
  explain.addEventListener("click", async () => {
    const selected = snapshot;
    if (!selected || sending) return;
    sending = true; explain.disabled = true;
    try { await host.ask(selected, "请解释我选中的这段内容，并结合必要的附近上下文。"); status.textContent = "已发送选中原文和版本位置。"; }
    catch (error) { status.textContent = errorText(error); }
    finally { sending = false; explain.disabled = !snapshot; }
  });
  return {
    context: currentContext,
    async go(line: number) {
      go(line); save(); await saveWork;
      if (saveError) throw new Error(`阅读位置未保存：${saveError}`);
    },
    async show(data: { asset: LibraryAsset; text: string; state: ReadingState }) {
      asset = data.asset; text = data.text; rendered = asset.githubSource?.format === "markdown"; savedLine = data.state.page ?? 1;
      container.hidden = false; status.textContent = "选中原文，点击解释选中内容。";
      el("text-reader-title").textContent = asset.fileName;
      el("text-reader-source").textContent = `${asset.githubSource!.repository} · ${asset.githubSource!.commit.slice(0, 12)} · ${asset.githubSource!.path}`;
      el("text-reader-toggle").hidden = asset.githubSource?.format !== "markdown";
      el<HTMLInputElement>("text-reader-line").max = String(asset.pageCount);
      render(); go(savedLine); await sync();
    },
    async hide() {
      clearTimeout(saveTimer); save(); await saveWork;
      if (saveError) throw new Error(`当前文件的阅读位置尚未保存：${saveError}。请重试后再切换。`);
      container.hidden = true; asset = null; snapshot = null; revision++;
    },
  };
}
