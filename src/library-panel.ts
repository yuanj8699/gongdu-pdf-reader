import type { LibraryAsset, LibraryEntry, ReadingState } from "./library-types.js";
import { uint8ArrayToBase64 } from "./pdf-annotations.js";
import "./library-panel.css";
import { createArxivPanel } from "./arxiv-panel.js";

export type LibraryCall = <T>(name: string, args: Record<string, unknown>) => Promise<T>;

/** Read only the legacy key for this exact rendered PDF; leave original data intact. */
export function legacyReadingState(fingerprint: string, pageCount: number): { clientId: string; state: ReadingState } | null {
  const key = `reader:${fingerprint}`;
  const raw = localStorage.getItem(`pdf-reader:bookmarks:v1:${encodeURIComponent(key)}`);
  const savedPage = localStorage.getItem(`${key}:page`);
  if (raw === null && savedPage === null) return null;
  const page = Number(savedPage);
  const state: ReadingState = { page: Number.isInteger(page) && page > 0 && page <= pageCount ? page : null, bookmarks: [] };
  if (raw !== null) {
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.bookmarks)) throw new Error("旧书签格式无法识别，原数据已保留。");
    state.bookmarks = data.bookmarks.filter((b: { page?: number; title?: string }) =>
      Number.isInteger(b?.page) && b.page! > 0 && b.page! <= pageCount && typeof b.title === "string",
    ).map((b: { page: number; title: string }) => ({ page: b.page, title: b.title.slice(0, 200) }));
  }
  const clientKey = "pdf-reader:legacy-client:v1";
  let clientId = localStorage.getItem(clientKey);
  if (!clientId) { clientId = crypto.randomUUID(); localStorage.setItem(clientKey, clientId); }
  return { clientId, state };
}

export function createLibraryPanel(container: HTMLElement, call: LibraryCall, openAsset: (assetId: string) => Promise<void>) {
  container.innerHTML = `<div class="library-heading"><div><h1>我的书库</h1><p>把本地 PDF 收进书库，接着上次读。</p></div>
    <button type="button" id="library-refresh">刷新</button></div>
    <label class="library-import">导入本地 PDF<input id="library-file" type="file" accept="application/pdf,.pdf"></label>
    <p class="library-note">原件、阅读位置和书签保存在本机书库。支持 512 MB 以内的 PDF。</p>
    <div class="library-progress"><p id="library-status" role="status" aria-live="polite"></p><button id="library-cancel" type="button" hidden>取消导入</button></div>
    <section id="arxiv-panel" hidden aria-label="arXiv 论文"></section>
    <ul id="library-list" aria-label="书库资料"></ul>`;
  const input = container.querySelector<HTMLInputElement>("#library-file")!;
  const list = container.querySelector<HTMLUListElement>("#library-list")!;
  const status = container.querySelector<HTMLElement>("#library-status")!;
  const cancel = container.querySelector<HTMLButtonElement>("#library-cancel")!;
  let importing = false, cancelled = false;
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);

  async function refresh() {
    const { entries } = await call<{ entries: LibraryEntry[] }>("library_list", {});
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("li");
      empty.className = "library-empty";
      empty.textContent = "书库还是空的。选择一份 PDF 开始阅读。";
      list.append(empty);
    }
    for (const asset of entries) {
      const item = document.createElement("li");
      item.className = "library-item";
      item.dataset.assetId = asset.assetId;
      const title = document.createElement("strong"); title.textContent = asset.title;
      const detail = document.createElement("span");
      detail.textContent = `${asset.source ? `${asset.source.id} · ` : ""}${asset.pageCount} 页 · ${(asset.byteLength / 1024 / 1024).toFixed(1)} MB${asset.lastPage ? ` · 上次读到第 ${asset.lastPage} 页` : ""}`;
      const button = document.createElement("button");
      button.type = "button"; button.textContent = asset.lastPage ? "继续阅读" : "开始阅读";
      button.setAttribute("aria-label", `${button.textContent}：${asset.title}`);
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await openAsset(asset.assetId); }
        catch (error) { status.textContent = `打开失败：${message(error)}`; }
        finally { button.disabled = false; }
      });
      item.append(title, detail, button); list.append(item);
    }
  }
  container.querySelector("#library-refresh")!.addEventListener("click", () => {
    void refresh().catch((error) => { status.textContent = `读取书库失败：${message(error)}`; });
  });
  cancel.addEventListener("click", () => { cancelled = true; cancel.disabled = true; });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file || importing) return;
    importing = true; cancelled = false; input.disabled = true; cancel.hidden = false; cancel.disabled = false;
    status.textContent = `准备导入 ${file.name}…`;
    let uploadId: string | undefined;
    try {
      ({ uploadId } = await call<{ uploadId: string }>("library_begin_upload", { fileName: file.name, size: file.size }));
      for (let offset = 0; offset < file.size; offset += 256 * 1024) {
        if (cancelled) break;
        const chunk = new Uint8Array(await file.slice(offset, offset + 256 * 1024).arrayBuffer());
        await call("library_upload_chunk", { uploadId, offset, bytes: uint8ArrayToBase64(chunk) });
        status.textContent = `正在导入 ${file.name} · ${Math.round((offset + chunk.length) / file.size * 100)}%`;
      }
      if (cancelled) {
        await call("library_cancel_upload", { uploadId }); uploadId = undefined;
        status.textContent = "已取消导入。";
      } else {
        cancel.disabled = true; status.textContent = "正在校验 PDF 并保存原件…";
        const asset = await call<LibraryAsset>("library_finish_upload", { uploadId }); uploadId = undefined;
        await refresh(); status.textContent = `已加入书库：${asset.title}。相同文件只保留一份。`;
      }
    } catch (error) {
      status.textContent = `导入失败：${message(error)}`;
      if (uploadId) await call("library_cancel_upload", { uploadId }).catch(() => {});
    } finally { importing = false; input.disabled = false; input.value = ""; cancel.hidden = true; }
  });
  const arxiv = createArxivPanel(container.querySelector("#arxiv-panel")!, call, refresh, openAsset);
  return { async show(arxivEnabled = false) {
    container.hidden = false;
    try { await refresh(); }
    catch (error) { status.textContent = `读取书库失败：${message(error)}`; }
    await arxiv.show(arxivEnabled);
  }, hide() { container.hidden = true; arxiv.hide(); } };
}
