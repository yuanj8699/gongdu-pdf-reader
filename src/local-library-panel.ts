import type { DirectoryScan, LocalPdf } from "../local-library.js";
import type { LibraryCall } from "./library-panel.js";

export function createLocalLibraryPanel(container: HTMLElement, call: LibraryCall, refreshLibrary: () => Promise<void>) {
  container.innerHTML = `<details open><summary>已连接的本地书库</summary>
    <label>文件夹<select id="local-library-root"></select></label>
    <div class="local-library-actions"><button id="local-library-scan" type="button">扫描 PDF</button>
    <button id="local-library-import" type="button" disabled>全部入库</button>
    <button id="local-library-stop" type="button" hidden>停止后续入库</button></div>
    <p id="local-library-status" role="status"></p><ul id="local-library-files" aria-label="本地书库文件"></ul></details>`;
  const root = container.querySelector<HTMLSelectElement>("select")!;
  const scanButton = container.querySelector<HTMLButtonElement>("#local-library-scan")!;
  const importButton = container.querySelector<HTMLButtonElement>("#local-library-import")!;
  const stopButton = container.querySelector<HTMLButtonElement>("#local-library-stop")!;
  const status = container.querySelector<HTMLElement>("#local-library-status")!;
  const filesList = container.querySelector<HTMLElement>("#local-library-files")!;
  let files: LocalPdf[] = [], busy = false, stopped = false;
  const detail = new Map<string, HTMLElement>();
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  const controls = () => {
    root.disabled = scanButton.disabled = busy;
    importButton.disabled = busy || !files.length;
    filesList.querySelectorAll("button").forEach(button => { button.disabled = busy; });
  };
  async function importFiles(chosen: LocalPdf[]) {
    if (busy) return;
    busy = true; stopped = false; controls(); stopButton.hidden = false;
    let completed = 0, failed = 0;
    try {
      for (const file of chosen) {
        if (stopped) break;
        status.textContent = `正在入库 ${completed + failed + 1}/${chosen.length}：${file.relativePath}`;
        try {
          await call("library_import_directory_pdf", { root: root.value, relativePath: file.relativePath });
          completed++; detail.get(file.relativePath)!.textContent = "已在书库中（相同内容只保留一份）";
        } catch (error) { failed++; detail.get(file.relativePath)!.textContent = `失败：${message(error)}`; }
      }
      status.textContent = `${stopped ? "已停止后续入库。" : "入库完成。"}${completed} 份已就绪，${failed} 份失败。原文件保持不变。`;
      await refreshLibrary();
    } catch (error) { status.textContent = `刷新书库失败：${message(error)}`; }
    finally { busy = false; stopButton.hidden = true; controls(); }
  }
  scanButton.addEventListener("click", async () => {
    if (busy) return;
    busy = true; controls(); status.textContent = "正在扫描文件夹…";
    try {
      const scan = await call<DirectoryScan>("library_scan_directory", { root: root.value });
      files = scan.files; filesList.replaceChildren(); detail.clear();
      for (const file of files) {
        const item = document.createElement("li"); item.className = "local-library-file";
        const name = document.createElement("strong"); name.textContent = file.relativePath;
        const size = document.createElement("span"); size.textContent = `${(file.byteLength / 1048576).toFixed(1)} MB`;
        const state = document.createElement("span"); detail.set(file.relativePath, state);
        const add = document.createElement("button"); add.type = "button"; add.textContent = "加入书库";
        add.addEventListener("click", () => { void importFiles([file]); });
        item.append(name, size, state, add); filesList.append(item);
      }
      status.textContent = `找到 ${files.length} 份 PDF。${scan.truncated ? "已达到扫描上限，当前仅显示部分文件。" : ""}${scan.skipped.length ? `跳过 ${scan.skipped.length} 项：${scan.skipped.slice(0, 3).join("；")}` : ""}`;
      scanButton.textContent = "重新扫描";
    } catch (error) { files = []; filesList.replaceChildren(); status.textContent = `扫描失败：${message(error)}`; }
    finally { busy = false; controls(); }
  });
  importButton.addEventListener("click", () => { void importFiles(files); });
  stopButton.addEventListener("click", () => { stopped = true; status.textContent = "当前文件完成后停止，已入库文件保留。"; });
  root.addEventListener("change", () => { files = []; filesList.replaceChildren(); status.textContent = "点击扫描查看文件。"; controls(); });
  return { async show() {
    if (busy) return;
    try {
      const { roots } = await call<{ roots: string[] }>("library_directories", {});
      container.hidden = !roots.length;
      if (Array.from(root.options).map(o => o.value).join("\n") !== roots.join("\n")) {
        root.replaceChildren(...roots.map(value => { const option = document.createElement("option"); option.value = option.textContent = value; return option; }));
        files = []; filesList.replaceChildren(); controls();
      }
    } catch (error) { container.hidden = false; status.textContent = `读取已连接文件夹失败：${message(error)}`; }
  } };
}
