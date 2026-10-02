import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import "./page-thumbnails.css";

const GROUP_SIZE = 12;
const PREVIEW_SIZE = 160;
let thumbnailCount = 0;

type Preview = {
  page: number; row: HTMLLIElement; jump: HTMLButtonElement; image: HTMLElement;
  status: HTMLElement; current: HTMLElement; retry: HTMLButtonElement;
  state: "pending" | "rendering" | "ready" | "failed";
  canvas?: HTMLCanvasElement;
};
type Work = {
  document: PDFDocumentProxy; generation: number;
  preview?: Preview; task?: RenderTask; canvas?: HTMLCanvasElement;
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(className: string, text: string) {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}
function release(canvas?: HTMLCanvasElement) {
  if (canvas) { canvas.width = canvas.height = 0; canvas.remove(); }
}

/** One group of previews from the original PDF, independent of reader rotation.
 * The owner supplies setActive(expanded && selectedTab === "pages") after load.
 * The shared PDF is never destroyed or cleaned up by this component. */
export function createPageThumbnails(container: HTMLElement, options: {
  onNavigate: (page: number) => void | Promise<void>;
}) {
  const id = `page-thumbnails-${++thumbnailCount}`;
  let pdf: PDFDocumentProxy | null = null;
  let active = false, destroyed = false, generation = 0;
  let currentPage = 1, groupStart = 1;
  let previews: Preview[] = [];
  let work: Work | null = null;

  container.classList.add("page-thumbnails");
  const toolbar = element("div", "page-thumbnails-toolbar");
  const range = element("p", "page-thumbnails-range", "打开 PDF 后浏览页面。");
  range.setAttribute("role", "status");
  const controls = element("div", "page-thumbnails-controls");
  const previous = button("page-thumbnails-prev", "上一组");
  const locate = button("page-thumbnails-current", "当前页");
  const next = button("page-thumbnails-next", "下一组");
  previous.setAttribute("aria-label", "上一组页面");
  next.setAttribute("aria-label", "下一组页面");
  controls.append(previous, locate, next);
  const note = element("p", "page-thumbnails-note", "原稿预览；阅读页可单独旋转。");
  toolbar.append(range, controls, note);
  const scroll = element("div", "page-thumbnails-scroll");
  const list = element("ul", "page-thumbnails-grid");
  list.setAttribute("aria-label", "PDF 页面缩略图");
  scroll.append(list);
  const announcement = element("p", "page-thumbnails-announcement");
  announcement.setAttribute("role", "status");
  container.replaceChildren(toolbar, scroll, announcement);

  const groupFor = (page: number) => Math.floor((page - 1) / GROUP_SIZE) * GROUP_SIZE + 1;
  const isCurrent = (run: Work) => !destroyed && active && work === run
    && pdf === run.document && generation === run.generation;

  function cancelWork() {
    generation++;
    const previousWork = work;
    work = null;
    previousWork?.task?.cancel();
    release(previousWork?.canvas);
    const preview = previousWork?.preview;
    if (preview?.state === "rendering") {
      preview.state = "pending";
      preview.status.textContent = "等待预览";
      preview.jump.removeAttribute("aria-busy");
    }
  }
  function updateControls() {
    previous.disabled = !pdf || groupStart === 1;
    next.disabled = !pdf || groupStart + GROUP_SIZE > pdf.numPages;
    locate.disabled = !pdf;
    locate.setAttribute("aria-label", `定位当前页：第 ${currentPage} 页`);
    range.textContent = pdf
      ? `第 ${groupStart}–${Math.min(groupStart + GROUP_SIZE - 1, pdf.numPages)} 页，共 ${pdf.numPages} 页`
      : "打开 PDF 后浏览页面。";
    for (const preview of previews) {
      const selected = preview.page === currentPage;
      if (selected) preview.jump.setAttribute("aria-current", "page");
      else preview.jump.removeAttribute("aria-current");
      preview.current.hidden = !selected;
    }
  }
  function revealCurrent() {
    if (!active) return;
    const preview = previews.find(item => item.page === currentPage);
    if (!preview) return;
    const bounds = scroll.getBoundingClientRect(), item = preview.row.getBoundingClientRect();
    if (item.top < bounds.top) scroll.scrollTop += item.top - bounds.top;
    else if (item.bottom > bounds.bottom) scroll.scrollTop += item.bottom - bounds.bottom;
  }
  function nextPreview() {
    const pending = previews.filter(preview => preview.state === "pending");
    const bounds = scroll.getBoundingClientRect();
    return pending.find(preview => {
      const item = preview.row.getBoundingClientRect();
      return item.width > 0 && item.bottom > bounds.top && item.top < bounds.bottom;
    }) ?? pending[0];
  }
  async function renderPreview(run: Work, preview: Preview) {
    run.preview = preview;
    preview.state = "rendering";
    preview.status.textContent = "正在预览…";
    preview.jump.setAttribute("aria-busy", "true");
    let canvas: HTMLCanvasElement | undefined;
    try {
      const page = await run.document.getPage(preview.page);
      if (!isCurrent(run)) return;
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PREVIEW_SIZE / Math.max(original.width, original.height) });
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      canvas = element("canvas", "page-thumbnail-canvas");
      canvas.setAttribute("aria-hidden", "true");
      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = "auto";
      run.canvas = canvas;
      run.task = page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
      await run.task.promise;
      if (!isCurrent(run)) return;
      preview.canvas = canvas;
      preview.image.append(canvas);
      preview.state = "ready";
      preview.status.hidden = true;
      preview.jump.removeAttribute("aria-describedby");
      preview.jump.removeAttribute("aria-busy");
    } catch (error) {
      if (!isCurrent(run)) return;
      preview.state = "failed";
      preview.status.textContent = "预览失败，仍可跳页";
      preview.retry.hidden = false;
      preview.retry.title = error instanceof Error ? error.message : "无法生成此页预览";
      preview.jump.removeAttribute("aria-busy");
    } finally {
      if (canvas !== preview.canvas) release(canvas);
      run.task = undefined; run.canvas = undefined; run.preview = undefined;
    }
  }
  function startRendering() {
    if (!active || !pdf || destroyed || work) return;
    const run: Work = { document: pdf, generation };
    work = run;
    void (async () => {
      while (isCurrent(run)) {
        const preview = nextPreview();
        if (!preview) break;
        await renderPreview(run, preview);
      }
      if (work === run) work = null;
    })();
  }
  function showGroup(start: number) {
    if (!pdf || destroyed) return;
    const target = Math.max(1, Math.min(groupFor(pdf.numPages), groupFor(start)));
    if (target === groupStart && previews.length) { updateControls(); return; }
    cancelWork();
    for (const preview of previews) release(preview.canvas);
    previews = [];
    list.replaceChildren();
    scroll.scrollTop = 0;
    groupStart = target;
    announcement.textContent = "";
    for (let page = groupStart; page <= Math.min(groupStart + GROUP_SIZE - 1, pdf.numPages); page++) {
      const row = element("li", "page-thumbnail");
      const jump = button("page-thumbnail-jump", "");
      jump.dataset.page = String(page);
      jump.setAttribute("aria-label", `跳转至第 ${page} 页`);
      const image = element("span", "page-thumbnail-preview");
      const status = element("span", "page-thumbnail-status", "等待预览");
      status.id = `${id}-page-${page}-status`;
      jump.setAttribute("aria-describedby", status.id);
      image.append(status);
      const caption = element("span", "page-thumbnail-caption");
      const current = element("span", "page-thumbnail-current", "当前页");
      caption.append(element("span", "", `第 ${page} 页`), current);
      jump.append(image, caption);
      const retry = button("page-thumbnail-retry", "重试预览");
      retry.setAttribute("aria-label", `重试第 ${page} 页预览`);
      retry.hidden = true;
      const preview: Preview = { page, row, jump, image, status, current, retry, state: "pending" };
      jump.addEventListener("click", async () => {
        const document = pdf;
        try { await options.onNavigate(page); }
        catch (error) {
          if (!destroyed && document === pdf) announcement.textContent = `无法跳转至第 ${page} 页：${error instanceof Error ? error.message : "请重试"}`;
        }
      });
      retry.addEventListener("click", () => {
        preview.state = "pending"; retry.hidden = true; status.textContent = "等待预览";
        startRendering();
      });
      row.append(jump, retry); list.append(row); previews.push(preview);
    }
    updateControls();
    startRendering();
  }
  function clear() {
    active = false;
    cancelWork();
    for (const preview of previews) release(preview.canvas);
    previews = []; pdf = null; currentPage = groupStart = 1;
    list.replaceChildren(); announcement.textContent = "";
    updateControls();
  }
  previous.addEventListener("click", () => showGroup(groupStart - GROUP_SIZE));
  next.addEventListener("click", () => showGroup(groupStart + GROUP_SIZE));
  locate.addEventListener("click", () => { showGroup(groupFor(currentPage)); revealCurrent(); startRendering(); });
  scroll.addEventListener("scroll", startRendering, { passive: true });
  clear();
  return {
    load(document: PDFDocumentProxy) {
      if (destroyed) return;
      clear(); pdf = document; showGroup(1);
    },
    setActive(value: boolean) {
      if (destroyed || active === value) return;
      active = value;
      if (!value) { cancelWork(); return; }
      showGroup(groupFor(currentPage)); revealCurrent(); startRendering();
    },
    setCurrentPage(page: number) {
      if (destroyed || !Number.isInteger(page) || page < 1 || (pdf && page > pdf.numPages)) return;
      if (currentPage === page) return;
      currentPage = page;
      if (pdf) showGroup(groupFor(page));
      updateControls(); revealCurrent();
    },
    clear,
    destroy() {
      clear(); destroyed = true;
      scroll.removeEventListener("scroll", startRendering);
      container.replaceChildren(); container.classList.remove("page-thumbnails");
    },
  };
}
