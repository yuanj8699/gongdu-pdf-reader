import { ACTIVE_IMPORT_STATES, type ArxivJob, type ArxivPaper } from "./arxiv-types.js";
import type { LibraryCall } from "./library-panel.js";

export function createArxivPanel(container: HTMLElement, call: LibraryCall, refreshLibrary: () => Promise<void>, openAsset: (id: string) => Promise<void>) {
  container.innerHTML = `<details><summary>从 arXiv 找论文</summary>
    <form id="arxiv-search-form"><label for="arxiv-query">关键词、论文编号或 arXiv 链接</label>
    <div class="arxiv-search-row"><input id="arxiv-query" required maxlength="500" placeholder="例如：Attention Is All You Need"><button type="submit">搜索</button></div></form>
    <p class="library-note">先选择确定版本，再下载到本机。也可输入 ti:标题、au:作者等查询。</p>
    <p id="arxiv-search-status" role="status"></p><ul id="arxiv-results" aria-label="arXiv 搜索结果"></ul>
    <div id="arxiv-paging" hidden><button id="arxiv-prev" type="button">上一页</button><button id="arxiv-next" type="button">下一页</button></div>
    </details><div class="arxiv-jobs-heading"><h2>论文下载</h2><button id="arxiv-jobs-refresh" type="button">刷新下载</button></div>
    <p id="arxiv-job-status" role="status"></p><ul id="arxiv-jobs" aria-label="论文下载任务"></ul>`;
  const form = container.querySelector<HTMLFormElement>("form")!;
  const queryInput = container.querySelector<HTMLInputElement>("#arxiv-query")!;
  const searchStatus = container.querySelector<HTMLElement>("#arxiv-search-status")!;
  const jobStatus = container.querySelector<HTMLElement>("#arxiv-job-status")!;
  const results = container.querySelector<HTMLElement>("#arxiv-results")!;
  const jobsList = container.querySelector<HTMLElement>("#arxiv-jobs")!;
  const paging = container.querySelector<HTMLElement>("#arxiv-paging")!;
  const previous = container.querySelector<HTMLButtonElement>("#arxiv-prev")!;
  const next = container.querySelector<HTMLButtonElement>("#arxiv-next")!;
  let start = 0, query = "", searching = false, visible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCompleted = "";
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  const button = (label: string, action: () => Promise<void>) => {
    const element = document.createElement("button"); element.type = "button"; element.textContent = label;
    element.addEventListener("click", async () => {
      element.disabled = true;
      try { await action(); } catch (error) { jobStatus.textContent = errorText(error); }
      finally { element.disabled = false; }
    }); return element;
  };
  async function download(id: string) {
    const job = await call<ArxivJob>("arxiv_download", { id });
    jobStatus.textContent = job.state === "completed" ? "该版本已在书库中。" : `已加入下载队列：${id}`;
    await refreshJobs();
  }
  function renderPaper(paper: ArxivPaper) {
    const item = document.createElement("li"); item.className = "library-item";
    const title = document.createElement("strong"); title.textContent = paper.title;
    const authors = document.createElement("span"); authors.textContent = paper.authors.join("、");
    const details = document.createElement("span"); details.textContent = `${paper.id} · ${paper.updated.slice(0, 10)}`;
    const abstract = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "摘要";
    const text = document.createElement("p"); text.textContent = paper.summary; abstract.append(summary, text);
    const row = document.createElement("div"); row.className = "arxiv-version-row";
    const label = document.createElement("label"); label.textContent = "版本 v ";
    const version = document.createElement("input"); version.type = "number"; version.min = "1"; version.max = String(paper.version);
    version.value = String(paper.version); version.setAttribute("aria-label", `${paper.baseId} 版本`); label.append(version);
    row.append(label, button("下载入库", async () => {
      if (!version.checkValidity() || !version.value) throw new Error(`请选择 1–${paper.version} 之间的整数版本。`);
      await download(`${paper.baseId}v${version.valueAsNumber}`);
    }));
    item.append(title, authors, details, abstract, row); results.append(item);
  }
  async function search(offset: number, expression: string) {
    if (searching) return;
    searching = true; searchStatus.textContent = "正在查询 arXiv…";
    const submit = form.querySelector<HTMLButtonElement>("button")!; submit.disabled = true;
    previous.disabled = next.disabled = true;
    try {
      const result = await call<{ papers: ArxivPaper[]; total: number; start: number }>("arxiv_search", { query: expression, start: offset });
      query = expression; start = result.start; results.replaceChildren(); result.papers.forEach(renderPaper);
      searchStatus.textContent = result.papers.length ? `共 ${result.total} 条 · 当前 ${start + 1}–${start + result.papers.length}` : "没有找到论文，请调整关键词或编号。";
      paging.hidden = result.total <= 10; previous.disabled = start === 0;
      next.disabled = start + result.papers.length >= result.total || start >= 1000 || !result.papers.length;
    } catch (error) { searchStatus.textContent = `查询失败：${errorText(error)}`; }
    finally { searching = false; submit.disabled = false; }
  }
  form.addEventListener("submit", event => { event.preventDefault(); void search(0, queryInput.value.trim()); });
  previous.addEventListener("click", () => { void search(Math.max(0, start - 10), query); });
  next.addEventListener("click", () => { void search(start + 10, query); });

  async function refreshJobs() {
    clearTimeout(timer);
    try {
      const { jobs } = await call<{ jobs: ArxivJob[] }>("arxiv_jobs", {});
      jobsList.replaceChildren();
      const labels: Record<ArxivJob["state"], string> = { queued: "排队中", resolving: "确认版本", downloading: "下载中", validating: "校验 PDF", completed: "已入库", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
      for (const job of jobs) {
        const item = document.createElement("li"); item.className = "library-item"; item.dataset.jobId = job.jobId;
        const title = document.createElement("strong"); title.textContent = job.paper?.title ?? job.requestedId;
        const progress = document.createElement("span");
        progress.textContent = `${job.requestedId} · ${labels[job.state]}${job.receivedBytes ? ` · ${(job.receivedBytes / 1048576).toFixed(1)} MB${job.totalBytes ? ` / ${(job.totalBytes / 1048576).toFixed(1)} MB` : ""}` : ""}`;
        item.append(title, progress);
        if (job.error) { const error = document.createElement("p"); error.textContent = job.error; item.append(error); }
        if (ACTIVE_IMPORT_STATES.includes(job.state)) item.append(button("取消", async () => { await call("arxiv_cancel", { jobId: job.jobId }); await refreshJobs(); }));
        else if (job.state === "completed" && job.assetId) item.append(button("打开论文", () => openAsset(job.assetId!)));
        else item.append(button("重新下载", () => download(job.requestedId)));
        jobsList.append(item);
      }
      const completed = jobs.filter(j => j.state === "completed").map(j => j.assetId).sort().join(",");
      if (completed !== lastCompleted) { lastCompleted = completed; await refreshLibrary(); }
      if (visible && jobs.some(j => ACTIVE_IMPORT_STATES.includes(j.state))) timer = setTimeout(() => { void refreshJobs(); }, 2000);
    } catch (error) { jobStatus.textContent = `读取下载状态失败：${errorText(error)}。可点击“刷新下载”重试。`; }
  }
  container.querySelector("#arxiv-jobs-refresh")!.addEventListener("click", () => { void refreshJobs(); });
  return {
    async show(enabled: boolean) { visible = enabled; container.hidden = !enabled; if (enabled) await refreshJobs(); },
    hide() { visible = false; clearTimeout(timer); },
  };
}
