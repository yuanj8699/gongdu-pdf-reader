import type { LibraryAsset, LibraryEntry, ReadingState } from "./library-types.js";
import { uint8ArrayToBase64 } from "./pdf-annotations.js";
import "./library-panel.css";
import { createArxivPanel } from "./arxiv-panel.js";
import { createLocalLibraryPanel } from "./local-library-panel.js";
import { createGithubPanel } from "./github-panel.js";

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
  container.innerHTML = `<div class="library-heading"><div><h1>我的书库</h1><p>收好 PDF、论文和仓库资料，接着上次读。</p></div>
    <button type="button" id="library-refresh">刷新</button></div>
    <label class="library-import">选择或拖入 PDF，可一次加入多份<input id="library-file" type="file" accept="application/pdf,.pdf" multiple></label>
    <p class="library-note">原件、阅读位置和书签保存在本机书库。每份 PDF 最大 512 MB；相同文件只保留一份。</p>
    <div class="library-progress"><p id="library-status" role="status" aria-live="polite"></p><button id="library-cancel" type="button" hidden>停止导入</button></div>
    <ol id="library-upload-queue" aria-label="PDF 导入队列" hidden></ol>
    <section id="local-library-panel" hidden aria-label="本地文件夹"></section>
    <section id="arxiv-panel" hidden aria-label="arXiv 论文"></section>
    <section id="github-panel" hidden aria-label="GitHub 仓库"></section>
    <div class="library-find"><label>查找书库<input id="library-search" type="search" placeholder="书名、文件名或仓库路径" autocomplete="off"></label>
    <label>排序<select id="library-sort"><option value="recent">最近阅读</option><option value="added">最近加入</option><option value="title">书名</option></select></label></div>
    <p id="library-count" class="library-note" role="status"></p><ul id="library-list" aria-label="书库资料"></ul>`;
  const input = container.querySelector<HTMLInputElement>("#library-file")!;
  const list = container.querySelector<HTMLUListElement>("#library-list")!;
  const status = container.querySelector<HTMLElement>("#library-status")!;
  const cancel = container.querySelector<HTMLButtonElement>("#library-cancel")!;
  const uploadList = container.querySelector<HTMLOListElement>("#library-upload-queue")!;
  const search = container.querySelector<HTMLInputElement>("#library-search")!;
  const sort = container.querySelector<HTMLSelectElement>("#library-sort")!;
  const count = container.querySelector<HTMLElement>("#library-count")!;
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  let entries: LibraryEntry[] = [];

  function renderEntries() {
    const query = search.value.trim().toLocaleLowerCase();
    const visible = entries.filter(asset => [asset.title, asset.fileName, asset.githubSource?.path]
      .some(value => value?.toLocaleLowerCase().includes(query)));
    if (sort.value === "added") visible.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    else if (sort.value === "title") visible.sort((a, b) => a.title.localeCompare(b.title, "zh-CN", { numeric: true }));
    count.textContent = query ? `找到 ${visible.length} / ${entries.length} 份资料` : `共 ${entries.length} 份资料`;
    list.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement("li");
      empty.className = "library-empty";
      empty.textContent = query ? "没有找到匹配的资料，试试其他关键词。" : "书库还是空的。选择或拖入 PDF 开始阅读。";
      list.append(empty);
    }
    for (const asset of visible) {
      const item = document.createElement("li");
      item.className = "library-item";
      item.dataset.assetId = asset.assetId;
      const title = document.createElement("strong"); title.textContent = asset.title;
      const detail = document.createElement("span");
      const unit = asset.githubSource && asset.githubSource.format !== "pdf" ? "行" : "页";
      detail.textContent = `${asset.githubSource ? `GitHub · ${asset.githubSource.commit.slice(0, 12)} · ` : asset.source ? `${asset.source.id} · ` : ""}${asset.pageCount} ${unit} · ${(asset.byteLength / 1024 / 1024).toFixed(1)} MB${asset.lastPage ? ` · 上次读到第 ${asset.lastPage} ${unit}` : ""}`;
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
  async function refresh() {
    ({ entries } = await call<{ entries: LibraryEntry[] }>("library_list", {}));
    renderEntries();
  }
  search.addEventListener("input", renderEntries);
  sort.addEventListener("change", renderEntries);
  container.querySelector("#library-refresh")!.addEventListener("click", () => {
    void refresh().catch((error) => { status.textContent = `读取书库失败：${message(error)}`; });
  });

  type UploadState = "waiting" | "uploading" | "validating" | "done" | "failed" | "cancelled";
  type Upload = { file: File; state: UploadState; item: HTMLLIElement; detail: HTMLElement; progress: HTMLProgressElement };
  const uploads: Upload[] = [];
  let work: Promise<void> | null = null, cancelled = false;
  function setUpload(upload: Upload, state: UploadState, detail: string, progress?: number) {
    upload.state = state;
    upload.item.dataset.state = state;
    upload.detail.textContent = detail;
    upload.progress.hidden = state !== "uploading" && state !== "validating";
    if (progress !== undefined) upload.progress.value = progress;
    else if (state === "validating") upload.progress.removeAttribute("value");
  }
  function updateSummary(finished = false) {
    const number = (state: UploadState) => uploads.filter(upload => upload.state === state).length;
    const done = number("done"), failed = number("failed"), stopped = number("cancelled");
    const outcome = !finished ? "正在导入。" : cancelled ? "已停止导入。"
      : done === 0 && failed > 0 ? "导入失败。" : failed > 0 ? "部分文件导入成功。" : "导入完成。";
    const saved = done > 0 ? `${done} 份已加入书库` : "尚无文件入库";
    status.textContent = `${outcome}${saved}，${failed} 份失败${stopped ? `，${stopped} 份已取消` : ""}${finished ? "。" : `，${number("waiting")} 份等待。`}`;
  }
  async function uploadOne(upload: Upload) {
    const { file } = upload;
    let uploadId: string | undefined;
    try {
      setUpload(upload, "uploading", "准备上传…", 0);
      ({ uploadId } = await call<{ uploadId: string }>("library_begin_upload", { fileName: file.name, size: file.size }));
      for (let offset = 0; offset < file.size && !cancelled; offset += 256 * 1024) {
        const chunk = new Uint8Array(await file.slice(offset, offset + 256 * 1024).arrayBuffer());
        if (cancelled) break;
        await call("library_upload_chunk", { uploadId, offset, bytes: uint8ArrayToBase64(chunk) });
        const progress = Math.round((offset + chunk.length) / file.size * 100);
        setUpload(upload, "uploading", `正在上传 · ${progress}%`, progress);
      }
      if (cancelled) {
        await call("library_cancel_upload", { uploadId }); uploadId = undefined;
        setUpload(upload, "cancelled", "已取消，未加入书库");
        return;
      }
      setUpload(upload, "validating", "正在校验 PDF 并保存原件…");
      // Once the server commits this file, keep it even if the user stops the queue.
      const asset = await call<LibraryAsset>("library_finish_upload", { uploadId }); uploadId = undefined;
      setUpload(upload, "done", `已加入书库：${asset.title}`);
    } catch (error) {
      let detail = `导入失败：${message(error)}`;
      // Final validation owns cleanup, including invalid PDFs; do not cancel an in-flight commit.
      if (uploadId && upload.state !== "validating") {
        try { await call("library_cancel_upload", { uploadId }); }
        catch (cleanupError) { detail += `；临时上传未能清理：${message(cleanupError)}`; }
      }
      setUpload(upload, "failed", detail);
    }
  }
  async function drainUploads() {
    // A new drop can append files while the current upload is in flight.
    let index = 0, refreshError: unknown;
    do {
      for (; index < uploads.length; index++) {
        const upload = uploads[index];
        if (upload.state !== "waiting") continue;
        if (cancelled) { setUpload(upload, "cancelled", "已取消，尚未开始"); continue; }
        updateSummary();
        await uploadOne(upload);
        updateSummary();
      }
      try { await refresh(); refreshError = undefined; }
      catch (error) { refreshError = error; }
      // Also drain files dropped while the list refresh was in flight.
    } while (index < uploads.length);
    updateSummary(true);
    if (refreshError) status.textContent += ` 读取书库失败：${message(refreshError)}。已入库文件仍保留，可点击刷新重试。`;
  }
  /** Adds files without navigating away from the current book. */
  function importFiles(files: Iterable<File>): Promise<void> {
    const chosen = [...files];
    if (!chosen.length) return work ?? Promise.resolve();
    if (cancelled && work) {
      status.textContent = "正在停止当前导入，请结束后重新选择或拖入文件。";
      return work;
    }
    if (!work) { uploads.length = 0; uploadList.replaceChildren(); cancelled = false; }
    for (const file of chosen) {
      const item = document.createElement("li"); item.className = "library-upload";
      const name = document.createElement("strong"); name.textContent = file.name;
      const detail = document.createElement("span");
      const progress = document.createElement("progress"); progress.max = 100; progress.value = 0; progress.hidden = true;
      progress.setAttribute("aria-label", `导入进度：${file.name}`);
      item.append(name, detail, progress); uploadList.append(item);
      const upload: Upload = { file, state: "waiting", item, detail, progress }; uploads.push(upload);
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") setUpload(upload, "failed", "仅支持 PDF 文件");
      else if (file.size === 0) setUpload(upload, "failed", "文件为空，无法导入");
      else if (file.size > 512 * 1024 * 1024) setUpload(upload, "failed", "文件超过 512 MB，请选择较小的 PDF");
      else setUpload(upload, "waiting", `等待导入 · ${(file.size / 1048576).toFixed(1)} MB`);
    }
    uploadList.hidden = false;
    cancel.hidden = false; cancel.disabled = false;
    updateSummary();
    if (!work) work = drainUploads().finally(() => { work = null; cancel.hidden = true; input.disabled = false; });
    return work;
  }
  cancel.addEventListener("click", () => {
    cancelled = true; cancel.disabled = true; input.disabled = true;
    for (const upload of uploads) if (upload.state === "waiting") setUpload(upload, "cancelled", "已取消，尚未开始");
    status.textContent = "正在停止导入。已加入书库的文件保留；已开始的最终校验会完成。";
  });
  input.addEventListener("change", () => {
    const files = [...input.files ?? []]; input.value = "";
    void importFiles(files);
  });
  let dragDepth = 0;
  const fileDrag = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
  container.addEventListener("dragenter", event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    dragDepth++; container.classList.add("library-drag-over");
  });
  container.addEventListener("dragover", event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = cancelled && work ? "none" : "copy";
  });
  container.addEventListener("dragleave", event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    if (--dragDepth <= 0) { dragDepth = 0; container.classList.remove("library-drag-over"); }
  });
  container.addEventListener("drop", event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    dragDepth = 0; container.classList.remove("library-drag-over");
    if (event.dataTransfer) void importFiles(event.dataTransfer.files);
  });
  const arxiv = createArxivPanel(container.querySelector("#arxiv-panel")!, call, refresh, openAsset);
  const local = createLocalLibraryPanel(container.querySelector("#local-library-panel")!, call, refresh);
  const github = createGithubPanel(container.querySelector("#github-panel")!, call, refresh, openAsset);
  return { importFiles, attachReader: github.attachReader, async show(arxivEnabled = false, githubEnabled = false) {
    container.hidden = false;
    try { await refresh(); }
    catch (error) { status.textContent = `读取书库失败：${message(error)}`; }
    await local.show();
    await arxiv.show(arxivEnabled);
    await github.show(githubEnabled);
  }, hide() { container.hidden = true; arxiv.hide(); } };
}
