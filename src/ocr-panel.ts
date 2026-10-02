import type { LibraryCall } from "./library-panel.js";
import type { OcrCapabilities, OcrJob, OcrResult } from "./ocr-types.js";
import "./ocr-panel.css";

type Page = { key: string; width: number; height: number; hasText: boolean };
/** The cached search text and selectable layer must use identical separators. */
function wordSeparator(left: string, right: string): string {
  return /[\u3400-\u9fff]$/.test(left) && /^[\u3400-\u9fff]/.test(right) ? "" : " ";
}
/** OCR output belongs to the rendered page identity, never to a later page. */
export function createOcrPanel(container: HTMLElement, layer: HTMLElement, nativeLayer: HTMLElement,
  call: LibraryCall, image: (rotation: number, signal: AbortSignal) => Promise<string>, changed: () => void) {
  container.className = "ocr-panel";
  container.innerHTML = '<button id="ocr-start" type="button">识别本页文字</button><details class="ocr-options"><summary>识别设置</summary><div><label>识别语言<select id="ocr-language" aria-label="OCR 识别语言"><option value="">自动选择</option></select></label><label>文字方向<select id="ocr-direction" aria-label="OCR 文字方向"><option value="0">保持原样</option><option value="270">逆时针转 90°</option><option value="180">转 180°</option><option value="90">顺时针转 90°</option></select></label></div></details><button id="ocr-cancel" type="button" hidden>取消识别</button><button id="ocr-original" type="button" hidden>使用原文字层</button><span id="ocr-status" role="status" aria-live="polite">扫描页无法选字时，可在本机识别。</span><details id="ocr-transcript" hidden><summary>核对识别文字</summary><pre id="ocr-transcript-text"></pre></details>';
  const start = container.querySelector<HTMLButtonElement>("#ocr-start")!;
  const cancel = container.querySelector<HTMLButtonElement>("#ocr-cancel")!;
  const original = container.querySelector<HTMLButtonElement>("#ocr-original")!;
  const language = container.querySelector<HTMLSelectElement>("#ocr-language")!;
  const status = container.querySelector<HTMLElement>("#ocr-status")!;
  const direction = container.querySelector<HTMLSelectElement>("#ocr-direction")!;
  const transcript = container.querySelector<HTMLDetailsElement>("#ocr-transcript")!;
  const transcriptText = container.querySelector<HTMLElement>("#ocr-transcript-text")!;
  let page: Page | null = null, revision = 0, disposed = false;
  type Run = { controller: AbortController; start?: Promise<{ jobId: string }>; jobId?: string; cancel?: Promise<void> };
  const runs = new Set<Run>();
  let capabilities: OcrCapabilities | undefined;
  type RecognizedPage = OcrResult & { resultId: string; rotation: number; searchText: string };
  const cache = new Map<string, RecognizedPage>();
  let active: RecognizedPage | undefined;
  const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
  function clearLayer() { layer.replaceChildren(); layer.hidden = true; nativeLayer.style.visibility = ""; active = undefined; original.hidden = true; transcript.hidden = true; transcriptText.textContent = ""; }
  function paint(result: RecognizedPage) {
    if (!page) return;
    clearLayer(); active = result;
    layer.hidden = false; nativeLayer.style.visibility = "hidden";
    original.hidden = false;
    const width = result.rotation % 180 ? page.height : page.width;
    const height = result.rotation % 180 ? page.width : page.height;
    layer.style.width = width + "px"; layer.style.height = height + "px";
    layer.style.left = (page.width - width) / 2 + "px"; layer.style.top = (page.height - height) / 2 + "px";
    layer.style.transform = "rotate(" + ((result.angle ?? 0) - result.rotation) + "deg)";
    transcript.hidden = false; transcriptText.textContent = result.text;
    const measure = document.createElement("canvas").getContext("2d")!;
    for (const line of result.lines) {
      const row = document.createElement("div"); row.className = "ocr-line"; row.style.display = "contents";
      layer.append(row);
      for (let i = 0; i < line.words.length; i++) {
        const word = line.words[i], span = document.createElement("span");
        const fontSize = Math.max(1, word.height * height);
        span.textContent = word.text;
        span.style.left = word.x * width + "px"; span.style.top = word.y * height + "px";
        span.style.fontSize = fontSize + "px";
        measure.font = fontSize + "px Arial";
        const natural = measure.measureText(word.text).width;
        if (natural > 0) span.style.transform = "scaleX(" + (word.width * width / natural) + ")";
        row.append(span);
        // Preserve word boundaries without introducing spaces between Chinese characters.
        if (i < line.words.length - 1) row.append(wordSeparator(word.text, line.words[i + 1].text));
      }
      row.append(document.createElement("br"));
    }
    status.textContent = "本页 OCR 已完成，可直接划选。识别可能有误，请对照原页核对；公式和表格不保证正确。";
    changed();
  }
  function cancelRun(run: Run): Promise<void> {
    run.controller.abort();
    // A start request can already own a server job before its reply arrives.
    // Share its cancellation promise so teardown waits for that reply and the
    // cancel acknowledgement, without waiting for an outstanding status poll.
    return run.cancel ??= (async () => {
      const id = run.jobId ?? (run.start ? (await run.start).jobId : undefined);
      if (id) await call("reader_ocr_cancel", { jobId: id });
    })();
  }
  function stop(): Promise<void> {
    revision++;
    cancel.hidden = true; start.disabled = !page || disposed; language.disabled = false; direction.disabled = false;
    return Promise.allSettled([...runs].map(cancelRun)).then(results => {
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
  }
  cancel.addEventListener("click", () => {
    const work = stop(), token = revision;
    status.textContent = "已停止接收结果，正在取消识别…";
    void work.then(() => { if (token === revision) status.textContent = "已取消识别，可以重新开始。"; })
      .catch(error => { if (token === revision) status.textContent = "已停止接收结果；取消服务任务未确认：" + describe(error); });
  });
  original.addEventListener("click", () => {
    const work = stop(), token = revision;
    void work.catch(error => { if (token === revision) status.textContent = "已恢复原文字层；取消识别未确认：" + describe(error); });
    if (page) cache.delete(page.key);
    clearLayer(); changed(); status.textContent = "已恢复原文字层，可重新识别。";
  });
  start.addEventListener("click", async () => {
    if (!page || start.disabled || disposed) return;
    const target = page.key, token = ++revision, rotation = Number(direction.value);
    const current = () => token === revision && page?.key === target;
    const run: Run = { controller: new AbortController() };
    runs.add(run);
    start.disabled = true; cancel.hidden = false; language.disabled = true; direction.disabled = true;
    status.textContent = "正在准备本机文字识别…";
    let localId: string | undefined;
    try {
      if (!capabilities) {
        const loaded = await call<OcrCapabilities>("reader_ocr_capabilities", {});
        if (!current()) return;
        capabilities = loaded;
        const automatic = document.createElement("option"); automatic.value = ""; automatic.textContent = "自动选择"; language.replaceChildren(automatic);
        for (const item of capabilities.languages) {
          const option = document.createElement("option"); option.value = item.tag; option.textContent = item.name; language.append(option);
        }
      }
      if (!capabilities.available) { const reason = capabilities.reason; capabilities = undefined; throw new Error(reason || "当前系统没有可用的本机 OCR 引擎。"); }
      const pngBase64 = await image(rotation, run.controller.signal);
      if (!current()) return;
      run.start = call<{jobId: string}>("reader_ocr_start", { pngBase64, ...(language.value ? {language: language.value} : {}) });
      const response = await run.start;
      localId = run.jobId = response.jobId;
      if (!current()) { await cancelRun(run); return; }
      status.textContent = "正在本机识别本页，可取消；首次识别可能需要稍候…";
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 450));
        if (!current()) return;
        const job = await call<OcrJob>("reader_ocr_status", {jobId: localId});
        if (!current()) return;
        if (job.status === "running") continue;
        if (job.status === "failed") throw new Error(job.error || "本页识别失败。");
        if (job.status === "cancelled") { status.textContent = "已取消识别。"; return; }
        if (!job.result?.text.trim()) { status.textContent = "没有识别出文字。请检查页面方向、清晰度或更换识别语言后重试。"; return; }
        const searchText = job.result.lines.map(line => line.words.map((word, index) =>
          (index ? wordSeparator(line.words[index - 1].text, word.text) : "") + word.text).join("")).join("\n");
        const recognized = { ...job.result, resultId: localId!, rotation, searchText };
        cache.delete(target); cache.set(target, recognized);
        if (cache.size > 8) cache.delete(cache.keys().next().value!);
        paint(recognized); return;
      }
    } catch (error) {
      if (current()) status.textContent = "识别未完成：" + describe(error);
      if (localId) {
        try { await cancelRun(run); }
        catch (cancelError) { if (current()) status.textContent += "；取消识别未确认：" + describe(cancelError); }
      }
    } finally {
      // Keep in-flight cancellation discoverable if dispose follows a normal
      // cancel. Failure is surfaced by stop's caller, not an unhandled promise.
      if (run.cancel) await run.cancel.catch(() => {});
      runs.delete(run);
      if (current()) { start.disabled = !page || disposed; cancel.hidden = true; language.disabled = false; direction.disabled = false; }
    }
  });
  return {
    layer,
    result() { return active; },
    cachedPage(generation: number, number: number, rotation: number) { return cache.get(generation + ":" + number + ":" + rotation); },
    async dispose() { disposed = true; page = null; clearLayer(); cache.clear(); await stop(); },
    invalidate(clearCache = false) {
      page = null; clearLayer();
      if (clearCache) cache.clear();
      const work = stop(), token = revision;
      void work.catch(error => { if (token === revision) status.textContent = "已停止使用旧页结果；取消识别未确认：" + describe(error); });
    },
    rendered(next: Page) {
      if (disposed) return;
      page = next; start.disabled = false;
      const result = cache.get(next.key);
      if (result) paint(result);
      else status.textContent = next.hasText ? "本页已有文字；若选字不正确，可重新识别。" : "本页未检测到文字，可在本机识别后划选并提问。";
    },
  };
}
