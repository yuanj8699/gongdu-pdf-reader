import type { HostBridge } from "./host-bridge.js";
import type { ReadingContext, TextReadingContext } from "./reading-context.js";

export type StudyContext = ReadingContext | TextReadingContext;
type StudyAction = "source" | "experiment" | "note";
type StudyEntry = { id: string; context: StudyContext; action: StudyAction; createdAt: string; note: string; status: string };
const actions = {
  source: { label: "查源码", prompt: "请围绕选中原文，在当前项目或引用仓库里查找相关实现。先阅读并解释，不修改代码。列出实际读取到的文件路径、版本与相关代码，区分查证结果和推测；若当前没有对应仓库访问权限，请明确说明。" },
  experiment: { label: "做实验", prompt: "请根据这段原文，在当前授权的开发目录中创建并运行一个最小实验，说明要验证的假设、输入、预期和实际结果。复用项目现有依赖，不改动主流程，不往知识笔记库放代码；若没有明确的开发目录或执行条件，先说明缺少什么。最后给出实验文件路径与运行结果，未运行时明确标注。" },
  note: { label: "记笔记", prompt: "" },
};

export function createStudyPanel(container: HTMLElement, host: HostBridge, getContext: () => StudyContext | null, resume: (context: StudyContext) => Promise<void>) {
  const key = "gongdu:study-records:v1";
  container.className = "study-panel";
  container.innerHTML = `<div class="study-actions" aria-label="把原文带入实践"><span id="study-selection">选中原文后可查源码、做实验或记笔记</span></div>
    <p id="study-status" role="status" aria-live="polite"></p><details id="study-history"><summary>学习记录</summary>
    <p class="library-note">记录保存在当前客户端本机。模型的实际回答、代码和运行结果请在当前对话中查看；可把自己的结论和文件路径记在这里。</p><ul id="study-entries"></ul></details>`;
  const toolbar = container.querySelector<HTMLElement>(".study-actions")!;
  const status = container.querySelector<HTMLElement>("#study-status")!;
  const list = container.querySelector<HTMLElement>("#study-entries")!;
  const history = container.querySelector<HTMLDetailsElement>("#study-history")!;
  let entries: StudyEntry[] = [], sending = false, loadFailed = false, loading = false;
  let unsavedReceiptId: string | null = null;
  const stored = new Map<string, string>(), pending = new Set<string>();
  const states = new Map<string, HTMLElement>();
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  function readStored(): StudyEntry[] {
    const saved = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(saved) || saved.some(entry => !entry || typeof entry.id !== "string" || !Object.hasOwn(actions, entry.action)
      || typeof entry.note !== "string" || typeof entry.status !== "string" || entry.context?.schemaVersion !== 1
      || entry.context.identity?.kind !== "library" || typeof entry.context.identity.assetId !== "string"
      || !["pdf", "markdown", "code"].includes(entry.context.location?.format))) throw new Error("学习记录格式无法识别，原数据已保留。");
    return saved;
  }
  try {
    entries = readStored();
    for (const entry of entries) stored.set(entry.id, JSON.stringify(entry));
  } catch (error) { loadFailed = true; status.textContent = `无法读取学习记录：${message(error)}`; }
  async function persist(entry: StudyEntry) {
    if (loadFailed) throw new Error("原学习记录未能读取，不能覆盖。请先导出或修复本机记录。");
    if (!navigator.locks) throw new Error("当前客户端不支持跨窗口安全保存学习记录。");
    const expected = stored.get(entry.id);
    // Read and replace only this record under the shared origin lock.
    await navigator.locks.request(key, () => {
      const latest = readStored(), previous = latest.find(value => value.id === entry.id);
      if (JSON.stringify(previous) !== expected) throw new Error("另一窗口已修改这条记录。请先复制当前笔记，再刷新查看最新版本；本次没有覆盖。");
      const next = previous ? latest.map(value => value.id === entry.id ? entry : value) : [...latest, entry];
      localStorage.setItem(key, JSON.stringify(next));
      stored.set(entry.id, JSON.stringify(entry));
      if (JSON.stringify(entries.find(value => value.id === entry.id)) === JSON.stringify(entry)) pending.delete(entry.id);
    });
  }
  function change(entry: StudyEntry) {
    entries = entries.map(value => value.id === entry.id ? entry : value);
    pending.add(entry.id);
  }
  function position(context: StudyContext) {
    return context.location.format === "pdf" ? `第 ${context.location.pageNumber} 页` : `第 ${context.location.lineStart}–${context.location.lineEnd} 行`;
  }
  function render() {
    list.replaceChildren();
    states.clear();
    history.querySelector("summary")!.textContent = `学习记录（${entries.length}）`;
    if (!entries.length) { list.textContent = "选一段原文，记录问题或自己的理解，下次从这里返回。"; return; }
    for (const entry of [...entries].reverse()) {
      const item = document.createElement("li");
      const heading = document.createElement("strong"); heading.textContent = `${actions[entry.action].label} · ${entry.context.title} · ${position(entry.context)}`;
      const state = document.createElement("p"); state.textContent = pending.has(entry.id)
        ? (entry.action === "note" ? "笔记尚未保存" : `${entry.status} · 本机修改尚未保存`) : entry.status;
      states.set(entry.id, state);
      const quote = document.createElement("blockquote"); quote.textContent = entry.context.selection?.text ?? "";
      const note = document.createElement("textarea"); note.value = entry.note; note.maxLength = 8000; note.rows = 3;
      note.dataset.entryId = entry.id;
      note.placeholder = "写下你的理解、未解决的问题、实验文件路径或运行结果";
      note.setAttribute("aria-label", `笔记：${entry.context.title} · ${position(entry.context)}`);
      note.addEventListener("input", () => {
        change({ ...entries.find(value => value.id === entry.id)!, note: note.value });
        state.textContent = "笔记尚未保存";
      });
      const save = document.createElement("button"); save.type = "button"; save.textContent = "保存笔记";
      save.addEventListener("click", async () => {
        save.disabled = true;
        const value = entries.find(value => value.id === entry.id)!;
        const updated = { ...value, note: note.value, status: value.action === "note" ? "笔记已保存到本机" : value.status };
        change(updated);
        try {
          await persist(updated);
          states.get(entry.id)!.textContent = pending.has(entry.id) ? "仍有新修改尚未保存" : "笔记已保存到本机";
          if (unsavedReceiptId === entry.id && !pending.has(entry.id)) { status.textContent = updated.status; unsavedReceiptId = null; }
        }
        catch (error) { states.get(entry.id)!.textContent = `笔记未保存：${message(error)}`; }
        finally { save.disabled = false; }
      });
      const back = document.createElement("button"); back.type = "button"; back.textContent = "返回原文";
      back.addEventListener("click", async () => {
        back.disabled = true;
        try { await resume(entry.context); history.open = false; status.textContent = `已返回 ${entry.context.title} · ${position(entry.context)}。选区原文保留在记录中。`; }
        catch (error) { state.textContent = `返回失败：${message(error)}`; }
        finally { back.disabled = false; }
      });
      item.append(heading, state, quote, note, save, back); list.append(item);
    }
  }
  const buttons: HTMLButtonElement[] = [];
  let selected: StudyContext | null = null;
  function refresh() {
    const context = loading ? null : getContext();
    selected = context?.selection && context.identity.kind === "library" ? structuredClone(context) : null;
    for (const button of buttons) button.disabled = sending || !selected || loadFailed;
    container.querySelector("#study-selection")!.textContent = selected ? `${position(selected)} · 已选 ${selected.selection!.text.length} 字`
      : context?.identity.kind === "transient" ? "加入书库后可保存实践与笔记记录" : "选中原文后可查源码、做实验或记笔记";
  }
  for (const action of Object.keys(actions) as StudyAction[]) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = actions[action].label;
    button.addEventListener("pointerdown", event => event.preventDefault());
    button.addEventListener("click", async () => {
      if (!selected || sending) return;
      const entry: StudyEntry = { id: crypto.randomUUID(), context: structuredClone(selected), action, createdAt: new Date().toISOString(), note: "", status: action === "note" ? "原文已保存，等待你的笔记" : "已保存原文，准备发送请求" };
      unsavedReceiptId = null;
      sending = true; refresh();
      try { await persist(entry); entries.push(entry); }
      catch (error) { status.textContent = `未能保存原文记录，操作未发送：${message(error)}`; sending = false; refresh(); return; }
      status.textContent = entry.status;
      render();
      if (action === "note") { sending = false; refresh(); history.open = true; list.querySelector("textarea")?.focus(); return; }
      status.textContent = `正在发送${actions[action].label}请求…`;
      try { await host.ask(entry.context, actions[action].prompt); entry.status = "请求已发送，请在当前对话查看实际结果"; }
      catch (error) { entry.status = message(error); }
      const received = { ...entries.find(value => value.id === entry.id)!, status: entry.status };
      change(received);
      try { await persist(received); status.textContent = entry.status; }
      catch (error) { unsavedReceiptId = entry.id; status.textContent = `${entry.status}；状态尚未保存，可用“保存笔记”重试本地保存：${message(error)}`; }
      sending = false;
      // Update only the status: never discard an unsaved note during an asynchronous reply.
      const state = states.get(entry.id); if (state) state.textContent = entry.status + (pending.has(entry.id) ? " · 本机修改尚未保存" : "");
      refresh();
    });
    buttons.push(button); toolbar.append(button);
  }
  document.addEventListener("selectionchange", () => {
    // Editing a note should not replace a captured source selection.
    if (!(document.activeElement instanceof HTMLTextAreaElement && container.contains(document.activeElement))) refresh();
  });
  window.addEventListener("storage", event => {
    if (event.storageArea !== localStorage || (event.key !== key && event.key !== null)) return;
    try {
      const latest = readStored();
      // Keep local drafts and their old baseline so conflicting saves are rejected.
      const drafts = entries.filter(entry => pending.has(entry.id));
      entries = latest.map(entry => drafts.find(draft => draft.id === entry.id) ?? entry);
      entries.push(...drafts.filter(entry => !latest.some(value => value.id === entry.id)));
      for (const entry of latest) if (!pending.has(entry.id)) stored.set(entry.id, JSON.stringify(entry));
      const active = document.activeElement instanceof HTMLTextAreaElement && container.contains(document.activeElement) ? document.activeElement : null;
      const focus = active ? { id: active.dataset.entryId, start: active.selectionStart, end: active.selectionEnd } : null;
      render();
      if (focus) {
        const note = [...list.querySelectorAll("textarea")].find(element => element.dataset.entryId === focus.id);
        note?.focus({ preventScroll: true }); note?.setSelectionRange(focus.start, focus.end);
      }
    } catch (error) { loadFailed = true; status.textContent = `无法同步学习记录，当前笔记已保留：${message(error)}`; }
    refresh();
  });
  render(); refresh();
  return { refresh, setLoading(value: boolean) {
    loading = value;
    if (value && !sending && !loadFailed) status.textContent = "";
    refresh();
  } };
}
