import { READER_SETTINGS_EVENT, readerWidgetPreferences } from "./reader-settings.js";
import "./reader-widgets.css";

export type ReaderProgress = { current: number; total: number; unit: "页" | "行"; title?: string };

/** Optional, unobtrusive reading tools. Elapsed time is local to this open view. */
export function createReaderWidgets(container: HTMLElement) {
  const bar = document.createElement("section");
  bar.className = "reader-widgets";
  bar.setAttribute("aria-label", "阅读小组件");
  bar.innerHTML = `<div class="reader-progress-widget">
    <span class="reader-progress-label"></span><progress aria-label="阅读位置"></progress><span class="reader-progress-percent" aria-hidden="true"></span>
    </div><div class="reader-focus-widget" title="仅在阅读器页面可见时累计；隐藏计时组件或离开阅读会暂停。本次计时不会跨页面保存。">
    <span>本次专注</span><output class="reader-focus-time" aria-label="本次专注时长">00:00</output>
    <button class="reader-focus-start" type="button">开始计时</button><button class="reader-focus-reset" type="button" disabled>重置计时</button>
    <span class="reader-focus-status" role="status"></span></div>`;
  container.append(bar);
  const progressWidget = bar.querySelector<HTMLElement>(".reader-progress-widget")!;
  const progressLabel = bar.querySelector<HTMLElement>(".reader-progress-label")!;
  const progressMeter = bar.querySelector<HTMLProgressElement>("progress")!;
  const progressPercent = bar.querySelector<HTMLElement>(".reader-progress-percent")!;
  const focusWidget = bar.querySelector<HTMLElement>(".reader-focus-widget")!;
  const time = bar.querySelector<HTMLOutputElement>(".reader-focus-time")!;
  const start = bar.querySelector<HTMLButtonElement>(".reader-focus-start")!;
  const reset = bar.querySelector<HTMLButtonElement>(".reader-focus-reset")!;
  const status = bar.querySelector<HTMLElement>(".reader-focus-status")!;
  let hasDocument = false;
  let elapsed = 0;
  let startedAt: number | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  function renderTime() {
    const seconds = Math.floor((elapsed + (startedAt === null ? 0 : performance.now() - startedAt)) / 1000);
    const minutes = Math.floor(seconds / 60);
    time.value = `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    start.textContent = startedAt === null ? (elapsed > 0 ? "继续计时" : "开始计时") : "暂停计时";
    start.setAttribute("aria-pressed", String(startedAt !== null));
    reset.disabled = elapsed === 0 && startedAt === null;
  }
  function pause(message?: string) {
    if (startedAt === null) return;
    elapsed += performance.now() - startedAt;
    startedAt = null;
    clearInterval(interval);
    interval = undefined;
    if (message) status.textContent = message;
    renderTime();
  }
  function updateVisibility() {
    const preferences = readerWidgetPreferences();
    progressWidget.hidden = !preferences.progress;
    focusWidget.hidden = !preferences.focus;
    bar.hidden = !hasDocument || (!preferences.progress && !preferences.focus);
    if (focusWidget.hidden || !hasDocument) pause("计时已暂停");
  }
  start.addEventListener("click", () => {
    if (startedAt !== null) { pause("计时已暂停"); return; }
    if (!hasDocument || !readerWidgetPreferences().focus || document.visibilityState !== "visible") return;
    startedAt = performance.now();
    status.textContent = "计时中";
    interval = setInterval(renderTime, 1000);
    renderTime();
  });
  reset.addEventListener("click", () => {
    pause();
    elapsed = 0;
    status.textContent = "计时已重置";
    renderTime();
  });
  const onVisibility = () => { if (document.visibilityState !== "visible") pause("离开页面，计时已暂停"); };
  const onPageHide = () => pause();
  document.addEventListener(READER_SETTINGS_EVENT, updateVisibility);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  updateVisibility();
  renderTime();
  return {
    setProgress(value: ReaderProgress | null) {
      hasDocument = Boolean(value && Number.isInteger(value.current) && Number.isInteger(value.total) && value.current > 0 && value.total >= value.current);
      if (hasDocument && value) {
        progressLabel.textContent = `第 ${value.current} / ${value.total} ${value.unit}`;
        progressMeter.max = value.total;
        progressMeter.value = value.current;
        progressMeter.setAttribute("aria-valuetext", progressLabel.textContent);
        progressPercent.textContent = `${Math.floor(value.current / value.total * 100)}%`;
        progressWidget.title = value.title ?? "阅读位置";
      }
      updateVisibility();
    },
    destroy() {
      pause();
      document.removeEventListener(READER_SETTINGS_EVENT, updateVisibility);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      bar.remove();
    },
  };
}
