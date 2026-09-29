export function createReaderSettings(container: HTMLElement) {
  const key = "gongdu:reader-settings:v1";
  container.insertAdjacentHTML("beforeend", `<details class="reader-settings"><summary>阅读设置</summary><div class="reader-settings-controls">
    <label>外观<select id="reader-theme"><option value="host">跟随客户端</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
    <label>正文字号<select id="reader-font"><option value="14">14</option><option value="16" selected>16</option><option value="18">18</option><option value="20">20</option></select></label>
    <label>目录宽度<select id="reader-width"><option value="200">紧凑</option><option value="240" selected>标准</option><option value="300">宽松</option></select></label>
    <span id="reader-settings-status" role="status"></span></div></details>`);
  const theme = container.querySelector<HTMLSelectElement>("#reader-theme")!;
  const font = container.querySelector<HTMLSelectElement>("#reader-font")!;
  const width = container.querySelector<HTMLSelectElement>("#reader-width")!;
  const status = container.querySelector<HTMLElement>("#reader-settings-status")!;
  let hostTheme: "light" | "dark" | undefined;
  function apply() {
    document.documentElement.style.colorScheme = theme.value === "host" ? hostTheme ?? "light dark" : theme.value;
    document.documentElement.style.setProperty("--reader-font-size", `${font.value}px`);
    document.documentElement.style.setProperty("--reader-navigation-width", `${width.value}px`);
  }
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    for (const [select, value] of [[theme, saved?.theme], [font, saved?.font], [width, saved?.width]] as const) {
      if ([...select.options].some(option => option.value === value)) select.value = value;
    }
  } catch { status.textContent = "无法恢复阅读设置，使用默认值。"; }
  if (!font.value) font.value = "16";
  if (!width.value) width.value = "240";
  apply();
  for (const select of [theme, font, width]) select.addEventListener("change", () => {
    apply();
    try { localStorage.setItem(key, JSON.stringify({ theme: theme.value, font: font.value, width: width.value })); status.textContent = "已保存到本机"; }
    catch { status.textContent = "设置已应用，但本机保存失败。"; }
  });
  return { followHost(value: "light" | "dark") { hostTheme = value; apply(); } };
}
