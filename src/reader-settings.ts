export const READER_SETTINGS_EVENT = "gongdu:reader-settings";

/** Widget preferences are also exposed for components mounted after settings. */
export function readerWidgetPreferences() {
  return {
    progress: document.documentElement.dataset.readerProgress !== "hidden",
    focus: document.documentElement.dataset.readerFocus === "visible",
  };
}

export function createReaderSettings(container: HTMLElement) {
  const key = "gongdu:reader-settings:v1";
  container.insertAdjacentHTML("beforeend", `<details class="reader-settings"><summary>阅读设置</summary><div class="reader-settings-controls">
    <div class="reader-settings-row">
      <label>明暗<select id="reader-theme"><option value="host">跟随客户端</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label>正文字号<select id="reader-font"><option value="14">14</option><option value="16" selected>16</option><option value="18">18</option><option value="20">20</option></select></label>
      <label>目录宽度<select id="reader-width"><option value="200">紧凑</option><option value="240" selected>标准</option><option value="300">宽松</option></select></label>
    </div>
    <fieldset class="reader-palette-options"><legend>配色</legend>
      <label><input type="radio" name="reader-palette" value="neutral" checked><span class="reader-palette-swatch" data-palette="neutral" aria-hidden="true"></span>中性</label>
      <label><input type="radio" name="reader-palette" value="sakura"><span class="reader-palette-swatch" data-palette="sakura" aria-hidden="true"></span>樱花</label>
      <label><input type="radio" name="reader-palette" value="sky"><span class="reader-palette-swatch" data-palette="sky" aria-hidden="true"></span>晴空</label>
      <label><input type="radio" name="reader-palette" value="matcha"><span class="reader-palette-swatch" data-palette="matcha" aria-hidden="true"></span>抹茶</label>
      <label><input type="radio" name="reader-palette" value="cocoa"><span class="reader-palette-swatch" data-palette="cocoa" aria-hidden="true"></span>可可</label>
    </fieldset>
    <fieldset class="reader-widget-options"><legend>阅读小组件</legend>
      <label><input id="reader-progress-toggle" type="checkbox" checked>阅读进度</label>
      <label><input id="reader-focus-toggle" type="checkbox">专注计时</label>
    </fieldset>
    <p class="reader-settings-hint">配色用于界面，保留 PDF 原稿颜色。字号用于 Markdown 和代码；PDF 请使用缩放。</p>
    <span id="reader-settings-status" role="status"></span></div></details>`);
  const theme = container.querySelector<HTMLSelectElement>("#reader-theme")!;
  const font = container.querySelector<HTMLSelectElement>("#reader-font")!;
  const width = container.querySelector<HTMLSelectElement>("#reader-width")!;
  const palettes = [...container.querySelectorAll<HTMLInputElement>('input[name="reader-palette"]')];
  const progress = container.querySelector<HTMLInputElement>("#reader-progress-toggle")!;
  const focus = container.querySelector<HTMLInputElement>("#reader-focus-toggle")!;
  const status = container.querySelector<HTMLElement>("#reader-settings-status")!;
  let hostTheme: "light" | "dark" | undefined;
  const palette = () => palettes.find(option => option.checked)!.value;
  function apply() {
    const root = document.documentElement;
    root.style.colorScheme = theme.value === "host" ? hostTheme ?? "light dark" : theme.value;
    root.style.setProperty("--reader-font-size", `${font.value}px`);
    root.style.setProperty("--reader-navigation-width", `${width.value}px`);
    root.dataset.readerPalette = palette();
    root.dataset.readerProgress = progress.checked ? "visible" : "hidden";
    root.dataset.readerFocus = focus.checked ? "visible" : "hidden";
    document.dispatchEvent(new CustomEvent(READER_SETTINGS_EVENT));
  }
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    for (const [select, value] of [[theme, saved?.theme], [font, saved?.font], [width, saved?.width]] as const) {
      if ([...select.options].some(option => option.value === value)) select.value = value;
    }
    const savedPalette = palettes.find(option => option.value === saved?.palette);
    if (savedPalette) savedPalette.checked = true;
    if (typeof saved?.progress === "boolean") progress.checked = saved.progress;
    if (typeof saved?.focus === "boolean") focus.checked = saved.focus;
  } catch { status.textContent = "无法恢复阅读设置，使用默认值。"; }
  apply();
  for (const control of [theme, font, width, ...palettes, progress, focus]) control.addEventListener("change", () => {
    apply();
    try {
      localStorage.setItem(key, JSON.stringify({
        theme: theme.value, font: font.value, width: width.value,
        palette: palette(), progress: progress.checked, focus: focus.checked,
      }));
      status.textContent = "已保存到本机";
    } catch { status.textContent = "设置已应用，但本机保存失败。"; }
  });
  return { followHost(value: "light" | "dark") { hostTheme = value; apply(); } };
}
