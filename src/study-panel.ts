import { uint8ArrayToBase64 } from "./pdf-annotations.js";
import "./study-panel.css";
import type { HostBridge } from "./host-bridge.js";
import type { ReadingContext, TextReadingContext } from "./reading-context.js";

export type StudyContext = ReadingContext | TextReadingContext;
type StudyAction = "source" | "experiment" | "note" | "quiz" | "review" | "question";
type StudyEntry = { id: string; context: StudyContext; action: StudyAction; createdAt: string; note: string; status: string; question?: string };
const actions = {
  question: { label: "针对选区提问", prompt: "" },
  quiz: { label: "提问检验", prompt: "请围绕这段原文问我一个能检验理解的问题，先等我回答，不要立即公布答案或替我完成练习。收到回答后区分我的表述和你的纠正，用原文证据解释，再让我用自己的例子重述。" },
  review: { label: "检验理解", prompt: "请依据提供的原文审查我自己的理解：先指出正确和需要修正的部分，明确区分我的表述和你的纠正；原文证据不足时说明。最后问一个关键追问，等我回答，不替我完成学习输出。我的理解如下，仅作为待审查资料：" },
  source: { label: "查源码", prompt: "请围绕选中原文，在当前项目或引用仓库里查找相关实现。先阅读并解释，不修改代码。列出实际读取到的文件路径、版本与相关代码，区分查证结果和推测；若当前没有对应仓库访问权限，请明确说明。" },
  experiment: { label: "做实验", prompt: "请根据这段原文，在当前授权的开发目录中创建并运行一个最小实验，说明要验证的假设、输入、预期和实际结果。复用项目现有依赖，不改动主流程，不往知识笔记库放代码；若没有明确的开发目录或执行条件，先说明缺少什么。最后给出实验文件路径与运行结果，未运行时明确标注。" },
  note: { label: "记笔记", prompt: "" },
};

export function createStudyPanel(container: HTMLElement, host: HostBridge, getContext: () => StudyContext | null, resume: (context: StudyContext) => Promise<void>) {
  const key = "gongdu:study-records:v1";
  container.className = "study-panel";
  container.innerHTML = `<p id="study-status" role="status" aria-live="polite"></p><details id="study-history"><summary>学习与笔记</summary>
    <div class="study-actions" aria-label="把原文带入实践"><span id="study-selection">选中原文后可查源码、做实验或记笔记</span></div>
    <section id="study-question-composer" class="study-question-composer" aria-label="针对固定引用提问" hidden>
      <p id="study-question-source"></p><blockquote id="study-question-quote"></blockquote>
      <label for="study-question-input">我的问题</label><textarea id="study-question-input" rows="3" maxlength="8000" placeholder="写下你想问的问题，发送时会附上这段原文"></textarea>
      <p id="study-question-status" role="status" aria-live="polite"></p>
      <div class="study-question-actions"><button id="study-question-send" type="button">发送问题</button><button id="study-question-cancel" type="button">取消</button></div>
    </section>
    <p class="library-note">先写下自己的理解，再请 AI 检验。笔记保存在当前客户端本机；请点击保存，可导出 Markdown 留存。</p><div class="study-filters"><label>记录范围<select id="study-scope"><option value="current">当前资料</option><option value="all">全部资料</option></select></label><input id="study-search" type="search" aria-label="搜索读书笔记" placeholder="搜索原文或笔记"><button id="study-export" type="button">导出笔记</button></div><ul id="study-entries"></ul></details>`;
  const toolbar = container.querySelector<HTMLElement>(".study-actions")!;
  const status = container.querySelector<HTMLElement>("#study-status")!;
  const list = container.querySelector<HTMLElement>("#study-entries")!;
  const history = container.querySelector<HTMLDetailsElement>("#study-history")!;
  // Keep the source selection when the reader opens actions with the mouse.
  history.querySelector("summary")!.addEventListener("pointerdown", event => {
    if (event.button === 0) event.preventDefault();
  });
  const scope = container.querySelector<HTMLSelectElement>("#study-scope")!;
  const search = container.querySelector<HTMLInputElement>("#study-search")!;
  const exportButton = container.querySelector<HTMLButtonElement>("#study-export")!;
  const questionComposer = container.querySelector<HTMLElement>("#study-question-composer")!;
  const questionSource = container.querySelector<HTMLElement>("#study-question-source")!;
  const questionQuote = container.querySelector<HTMLElement>("#study-question-quote")!;
  const questionInput = container.querySelector<HTMLTextAreaElement>("#study-question-input")!;
  const questionStatus = container.querySelector<HTMLElement>("#study-question-status")!;
  const questionSend = container.querySelector<HTMLButtonElement>("#study-question-send")!;
  const questionCancel = container.querySelector<HTMLButtonElement>("#study-question-cancel")!;
  let questionDraft: { context: StudyContext; retryId?: string; attemptedQuestion?: string } | null = null;
  let activeAsset: string | null = null, activePosition = "";
  let visibleIds = new Set<string>();
  let entries: StudyEntry[] = [], sending = false, loadFailed = false, loading = false;
  let unsavedReceiptId: string | null = null;
  let sendingEntryId: string | null = null;
  let deleteConfirmation: { id: string; expected: string | undefined; error?: string } | null = null;
  const saving = new Set<string>(), deleting = new Set<string>(), returning = new Set<string>();
  let returnRequest = 0;
  const stored = new Map<string, string>(), pending = new Set<string>();
  const states = new Map<string, HTMLElement>();
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  function readStored(): StudyEntry[] {
    const saved = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(saved) || saved.some(entry => !entry || typeof entry.id !== "string" || !Object.hasOwn(actions, entry.action)
      || (entry.action === "question" && (typeof entry.question !== "string" || !entry.question.trim()))
      || typeof entry.note !== "string" || typeof entry.status !== "string" || entry.context?.schemaVersion !== 1
      || entry.context.identity?.kind !== "library" || typeof entry.context.identity.assetId !== "string"
      || !["pdf", "markdown", "code"].includes(entry.context.location?.format))) throw new Error("学习记录格式无法识别，原数据已保留。");
    return saved;
  }
  try {
    entries = readStored();
    for (const entry of entries) stored.set(entry.id, JSON.stringify(entry));
  } catch (error) { loadFailed = true; status.textContent = `无法读取学习记录：${message(error)}`; }
  function entryButton(id: string, action: string) {
    return [...list.querySelectorAll<HTMLButtonElement>("button[data-entry-action]")]
      .find(button => button.dataset.entryId === id && button.dataset.entryAction === action);
  }
  function updateEntryControls() {
    for (const button of list.querySelectorAll<HTMLButtonElement>("button[data-entry-action]")) {
      const id = button.dataset.entryId!, action = button.dataset.entryAction;
      const confirming = deleteConfirmation?.id === id;
      const busy = saving.has(id) || deleting.has(id) || (action === "back" && returning.has(id));
      button.disabled = action === "cancel-delete" ? deleting.has(id)
        : busy || ((action === "delete" || action === "confirm-delete") && (sending || loadFailed || deleting.size > 0))
          || (confirming && (action === "save" || action === "back" || action === "review" || action === "delete"));
    }
    for (const note of list.querySelectorAll<HTMLTextAreaElement>("textarea[data-entry-id]")) {
      note.disabled = deleteConfirmation?.id === note.dataset.entryId || deleting.has(note.dataset.entryId!);
    }
  }
  async function persist(entry: StudyEntry) {
    if (loadFailed) throw new Error("原学习记录未能读取，不能覆盖。请先导出或修复本机记录。");
    if (!navigator.locks) throw new Error("当前客户端不支持跨窗口安全保存学习记录。");
    if (saving.has(entry.id) || deleting.has(entry.id)) throw new Error("这条记录正在保存或删除，请稍候再试。");
    const expected = stored.get(entry.id);
    saving.add(entry.id); updateEntryControls();
    try {
      // Read and replace only this record under the shared origin lock.
      await navigator.locks.request(key, () => {
        const latest = readStored(), previous = latest.find(value => value.id === entry.id);
        if (JSON.stringify(previous) !== expected) throw new Error("另一窗口已修改这条记录。请先复制当前笔记，再刷新查看最新版本；本次没有覆盖。");
        const next = previous ? latest.map(value => value.id === entry.id ? entry : value) : [...latest, entry];
        localStorage.setItem(key, JSON.stringify(next));
        stored.set(entry.id, JSON.stringify(entry));
        if (JSON.stringify(entries.find(value => value.id === entry.id)) === JSON.stringify(entry)) pending.delete(entry.id);
      });
    } finally { saving.delete(entry.id); updateEntryControls(); }
  }
  function mergeStoredEntries(latest: StudyEntry[]) {
    // A confirmation or an outstanding AI reply owns its original baseline,
    // just like an unsaved draft; a storage event must not silently replace it.
    const local = entries.filter(entry => pending.has(entry.id) || deleteConfirmation?.id === entry.id || sendingEntryId === entry.id);
    entries = latest.map(entry => local.find(value => value.id === entry.id) ?? entry);
    entries.push(...local.filter(entry => !latest.some(value => value.id === entry.id)));
    for (const entry of latest) if (!local.some(value => value.id === entry.id)) stored.set(entry.id, JSON.stringify(entry));
  }
  async function deleteEntry(id: string) {
    const confirmation = deleteConfirmation;
    if (!confirmation || confirmation.id !== id || sending || saving.has(id) || deleting.size || loadFailed) return;
    const index = [...list.querySelectorAll<HTMLButtonElement>('button[data-entry-action="delete"]')]
      .findIndex(button => button.dataset.entryId === id);
    deleting.add(id); updateEntryControls();
    let removed = false;
    try {
      if (!navigator.locks) throw new Error("当前客户端不支持跨窗口安全删除学习记录。");
      const next = await navigator.locks.request(key, () => {
        const latest = readStored(), previous = latest.find(entry => entry.id === id);
        if (JSON.stringify(previous) !== confirmation.expected) throw new Error("另一窗口已修改或删除这条记录。当前记录与草稿已保留，请复制后刷新核对。");
        const remaining = latest.filter(entry => entry.id !== id);
        localStorage.setItem(key, JSON.stringify(remaining));
        return remaining;
      });
      entries = entries.filter(entry => entry.id !== id);
      stored.delete(id); pending.delete(id); states.delete(id);
      if (unsavedReceiptId === id) unsavedReceiptId = null;
      deleteConfirmation = null;
      mergeStoredEntries(next);
      removed = true;
      render();
      if (!unsavedReceiptId) status.textContent = "已删除这条本机学习记录。";
    } catch (error) {
      confirmation.error = "删除失败：" + message(error);
      render();
    } finally {
      deleting.delete(id); updateEntryControls();
      if (removed) {
        const remaining = [...list.querySelectorAll<HTMLButtonElement>('button[data-entry-action="delete"]')];
        (remaining[Math.min(index, remaining.length - 1)] ?? history.querySelector<HTMLElement>("summary"))?.focus();
      } else entryButton(id, "cancel-delete")?.focus();
    }
  }
  function change(entry: StudyEntry) {
    entries = entries.map(value => value.id === entry.id ? entry : value);
    pending.add(entry.id);
  }
  function position(context: StudyContext) {
    return context.location.format === "pdf" ? `第 ${context.location.pageNumber} 页` : `第 ${context.location.lineStart}–${context.location.lineEnd} 行`;
  }
  function filteredEntries() {
    const term = search.value.trim().toLocaleLowerCase();
    return entries.filter(entry => (scope.value === "all" || entry.context.identity.kind === "library" && entry.context.identity.assetId === activeAsset)
      && (!term || [entry.context.title, entry.context.selection?.text ?? "", entry.question ?? "", entry.note].join(" ").toLocaleLowerCase().includes(term)));
  }
  function showEntryStatus(id: string, text: string, announceWhenCollapsed = false) {
    const state = states.get(id); if (state) state.textContent = text;
    if (announceWhenCollapsed && !history.open) status.textContent = text;
  }
  function render() {
    list.replaceChildren();
    states.clear();
    const visible = filteredEntries();
    visibleIds = new Set(visible.map(entry => entry.id));
    history.querySelector("summary")!.textContent = `学习与笔记（${visible.length}）`;
    exportButton.disabled = !visible.length;
    if (!visible.length) { list.textContent = entries.length ? "当前范围没有匹配记录，可切换全部资料或清除搜索。" : "选一段原文或直接记本页笔记，下次从这里返回。"; return; }
    for (const entry of [...visible].reverse()) {
      const item = document.createElement("li"); item.dataset.entryId = entry.id;
      const heading = document.createElement("strong"); heading.textContent = `${actions[entry.action].label} · ${entry.context.title} · ${position(entry.context)}`;
      const state = document.createElement("p"); state.textContent = pending.has(entry.id)
        ? (entry.action === "note" ? "笔记尚未保存" : `${entry.status} · 本机修改尚未保存`) : entry.status;
      states.set(entry.id, state);
      const quote = document.createElement("blockquote"); quote.textContent = entry.context.selection?.text ?? "这条笔记记录了阅读位置，没有引用选区。";
      if (entry.context.textSource?.kind === "ocr") quote.setAttribute("aria-label", "OCR 识别原文，未经核对");
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
        if (saving.has(entry.id) || deleting.has(entry.id) || deleteConfirmation?.id === entry.id) return;
        save.disabled = true;
        const value = entries.find(value => value.id === entry.id)!;
        const updated = { ...value, note: note.value, status: value.action === "note" ? "笔记已保存到本机" : value.status };
        change(updated);
        try {
          await persist(updated);
          showEntryStatus(entry.id, pending.has(entry.id) ? "仍有新修改尚未保存" : "笔记已保存到本机", true);
          if (unsavedReceiptId === entry.id && !pending.has(entry.id)) { status.textContent = updated.status; unsavedReceiptId = null; }
        }
        catch (error) { showEntryStatus(entry.id, `笔记未保存：${message(error)}`, true); }
        finally { updateEntryControls(); }
      });
      const back = document.createElement("button"); back.type = "button"; back.textContent = "返回原文";
      back.addEventListener("click", async () => {
        const request = ++returnRequest;
        returning.add(entry.id);
        back.disabled = true;
        try {
          await resume(entry.context);
          if (request !== returnRequest) return;
          history.open = false;
          status.textContent = `已返回 ${entry.context.title} · ${position(entry.context)}。选区原文保留在记录中。`;
        } catch (error) {
          if (request !== returnRequest || error instanceof DOMException && error.name === "AbortError") {
            showEntryStatus(entry.id, "已取消较早的返回请求。");
          } else showEntryStatus(entry.id, `返回失败：${message(error)}`, true);
        }
        finally { returning.delete(entry.id); updateEntryControls(); }
      });
      const review = document.createElement("button"); review.type = "button"; review.textContent = "检验我的理解";
      review.addEventListener("click", () => {
        if (!note.value.trim()) { state.textContent = "先写下你自己的理解，再请 AI 检验。"; note.focus(); return; }
        if (!entry.context.selection?.text) { state.textContent = "请先选中原文建立笔记，才能让 AI 对照原文检验。"; return; }
        void addEntry("review", structuredClone(entry.context), note.value);
      });
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "删除记录";
      remove.setAttribute("aria-expanded", String(deleteConfirmation?.id === entry.id));
      remove.addEventListener("click", () => {
        if (sending || saving.has(entry.id) || deleting.size || loadFailed) return;
        deleteConfirmation = { id: entry.id, expected: stored.get(entry.id) };
        render(); entryButton(entry.id, "cancel-delete")?.focus();
      });
      for (const [button, action] of [[save, "save"], [back, "back"], [review, "review"], [remove, "delete"]] as const) {
        button.dataset.entryId = entry.id; button.dataset.entryAction = action;
      }
      item.append(heading, state, quote);
      if (entry.question !== undefined) {
        const question = document.createElement("p"); question.className = "study-entry-question";
        const label = document.createElement("strong"); label.textContent = "我的问题：";
        question.append(label, document.createTextNode(entry.question)); item.append(question);
        note.placeholder = "写下你的理解、回答后的判断和仍未解决的问题";
        note.setAttribute("aria-label", "我的理解：" + entry.context.title + " · " + position(entry.context));
      }
      item.append(note, save, back, review, remove);
      if (deleteConfirmation?.id === entry.id) {
        const confirmation = document.createElement("div"); confirmation.className = "study-delete-confirm";
        confirmation.setAttribute("role", "group"); confirmation.setAttribute("aria-label", "确认删除学习记录");
        const warning = document.createElement("p");
        warning.textContent = "确认删除这条记录？仅删除本机学习记录，不影响原文或聊天中的消息。"
          + (pending.has(entry.id) ? "这条记录的未保存草稿和状态也会一并丢弃。" : "");
        const error = document.createElement("p"); error.className = "study-delete-error"; error.setAttribute("role", "alert");
        error.textContent = deleteConfirmation.error ?? ""; error.hidden = !deleteConfirmation.error;
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "取消";
        const confirm = document.createElement("button"); confirm.type = "button"; confirm.textContent = "确认删除";
        for (const [button, action] of [[cancel, "cancel-delete"], [confirm, "confirm-delete"]] as const) {
          button.dataset.entryId = entry.id; button.dataset.entryAction = action;
        }
        const cancelDelete = () => {
          if (deleting.has(entry.id)) return;
          deleteConfirmation = null; render(); entryButton(entry.id, "delete")?.focus();
        };
        cancel.addEventListener("click", cancelDelete);
        confirmation.addEventListener("keydown", event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelDelete(); }
        });
        confirm.addEventListener("click", () => void deleteEntry(entry.id));
        confirmation.append(warning, error, cancel, confirm); item.append(confirmation);
      }
      list.append(item);
    }
    updateEntryControls();
  }
  const buttons: HTMLButtonElement[] = [];
  let selected: StudyContext | null = null;
  function refresh() {
    const context = loading ? null : getContext();
    selected = context?.selection && context.identity.kind === "library" ? structuredClone(context) : null;
    const asset = context?.identity.kind === "library" ? context.identity.assetId : null;
    if (asset !== activeAsset) { activeAsset = asset; render(); }
    const location = context ? asset + ":" + position(context) : "";
    if (location !== activePosition) { activePosition = location; if (!sending && !unsavedReceiptId && !loadFailed) status.textContent = ""; }
    for (const button of buttons) {
      button.disabled = sending || loadFailed || (button.dataset.action === "note" ? !asset : button.dataset.action === "question" && questionDraft ? false : !selected);
      if (button.dataset.action === "question") button.textContent = questionDraft ? "继续编辑问题" : actions.question.label;
      if (button.dataset.action === "note") button.textContent = selected ? "记笔记" : "记本页笔记";
    }
    updateEntryControls(); updateQuestionControls();
    container.querySelector("#study-selection")!.textContent = selected ? `${position(selected)} · 已选 ${selected.selection!.text.length} 字`
      : context?.identity.kind === "transient" ? "加入书库后可保存实践与笔记记录" : context ? position(context) + " · 记下自己的理解" : "选择资料开始共读";
  }
  async function addEntry(action: StudyAction, context: StudyContext, note = "", question?: { text: string; retryId?: string }) {
    if (sending || loadFailed || context.identity.kind !== "library") return;
    const retry = question?.retryId ? entries.find(entry => entry.id === question.retryId) : undefined;
    if (question?.retryId && (!retry || retry.action !== "question" || retry.question !== question.text)) {
      status.textContent = "原问题记录已改变或删除。请先复制问题，再取消并重新选择原文。"; return;
    }
    const entry: StudyEntry = retry ? { ...retry, status: "已保存原文，准备重新发送请求" }
      : { id: crypto.randomUUID(), context: structuredClone(context), action, createdAt: new Date().toISOString(), note,
        ...(question ? { question: question.text } : {}), status: action === "note" ? "出处已保存，等待你的笔记" : "已保存原文，准备发送请求" };
    unsavedReceiptId = null; sending = true; sendingEntryId = entry.id; refresh();
    try {
      await persist(entry);
      if (retry) {
        // Keep edits made while this retry waited for another window's lock.
        const current = entries.find(value => value.id === entry.id)!;
        const updated = current !== retry ? { ...current, status: entry.status } : entry;
        entries = entries.map(value => value.id === entry.id ? updated : value);
        if (JSON.stringify(updated) === stored.get(entry.id)) pending.delete(entry.id);
        else pending.add(entry.id);
      } else entries.push(entry);
    }
    catch (error) { status.textContent = "未能保存原文记录，操作未发送：" + message(error); sending = false; sendingEntryId = null; refresh(); return; }
    status.textContent = entry.status;
    search.value = "";
    if (activeAsset !== context.identity.assetId) scope.value = "all";
    render();
    if (action === "note") { sending = false; sendingEntryId = null; refresh(); if (history.open) list.querySelector("textarea")?.focus(); return; }
    status.textContent = "正在发送" + actions[action].label + "请求…";
    let delivered = false;
    try {
      await host.ask(entry.context, action === "question" ? entry.question! : actions[action].prompt + (action === "review" ? "\n" + JSON.stringify(note) : ""));
      delivered = true;
      entry.status = "请求已发送，请在当前对话查看实际结果";
    } catch (error) { entry.status = message(error); }
    const received = { ...entries.find(value => value.id === entry.id)!, status: entry.status };
    change(received);
    try { await persist(received); status.textContent = entry.status; }
    catch (error) { unsavedReceiptId = entry.id; status.textContent = entry.status + "；状态尚未保存，可用保存笔记重试：" + message(error); }
    sending = false; sendingEntryId = null;
    showEntryStatus(entry.id, entry.status + (pending.has(entry.id) ? " · 本机修改尚未保存" : ""));
    refresh();
    return { entryId: entry.id, delivered };
  }
  function updateQuestionControls() {
    questionComposer.hidden = !questionDraft;
    questionInput.disabled = sending;
    questionCancel.disabled = sending;
    questionSend.disabled = sending || loadFailed || !questionDraft || !questionInput.value.trim();
    const retrying = questionDraft?.retryId && questionDraft.attemptedQuestion === questionInput.value.trim();
    questionSend.textContent = sending && questionDraft ? "正在发送…" : retrying ? "重新发送" : "发送问题";
  }
  function clearQuestionDraft() {
    questionDraft = null; questionInput.value = ""; questionStatus.textContent = ""; refresh();
  }
  function openQuestion() {
    if (!questionDraft) {
      if (!selected) return;
      questionDraft = { context: structuredClone(selected) };
      questionSource.textContent = "引用已固定 · " + selected.title + " · " + position(selected) + "。翻页不会改变这段引用。";
      questionQuote.textContent = selected.selection!.text;
      if (selected.textSource?.kind === "ocr") questionQuote.setAttribute("aria-label", "OCR 识别原文，未经核对");
      else questionQuote.removeAttribute("aria-label");
    }
    history.open = true; refresh(); questionInput.focus();
  }
  questionInput.addEventListener("input", updateQuestionControls);
  questionCancel.addEventListener("click", () => {
    if (sending) return;
    clearQuestionDraft(); history.querySelector<HTMLElement>("summary")?.focus();
  });
  questionSend.addEventListener("click", async () => {
    const draft = questionDraft, text = questionInput.value.trim();
    if (!draft || !text || sending || loadFailed) return;
    questionStatus.textContent = "正在保存原文并发送问题…";
    const retryId = draft.attemptedQuestion === text ? draft.retryId : undefined;
    const result = await addEntry("question", draft.context, "", { text, retryId });
    if (questionDraft !== draft) return;
    if (result?.delivered) {
      clearQuestionDraft(); history.querySelector<HTMLElement>("summary")?.focus();
    } else {
      if (result) { draft.retryId = result.entryId; draft.attemptedQuestion = text; }
      questionStatus.textContent = status.textContent;
      updateQuestionControls(); questionInput.focus();
    }
  });
  for (const action of ["question", "note", "quiz", "source", "experiment"] as const) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = actions[action].label; button.dataset.action = action;
    button.addEventListener("pointerdown", event => event.preventDefault());
    button.addEventListener("click", () => {
      if (action === "question") { openQuestion(); return; }
      const context = selected ?? (action === "note" && !loading ? getContext() : null);
      if (context) void addEntry(action, context);
    });
    buttons.push(button); toolbar.append(button);
  }
  scope.addEventListener("change", render); search.addEventListener("input", render);
  exportButton.addEventListener("click", async () => {
    const records = entries.filter(entry => visibleIds.has(entry.id));
    if (!records.length) return;
    const markdown = "# 共读读书笔记\n\n" + records.map(entry => {
      const quote = entry.context.selection?.text ?? "（未引用选区）";
      return "## " + entry.context.title.replace(/\n/g, " ") + " · " + position(entry.context) + "\n\n"
        + "记录时间：" + entry.createdAt + "\n\n"
        + "原文出处：" + entry.context.source.uri + "\n\n"
        + (entry.context.identity.kind === "library" ? "文档版本：" + entry.context.identity.versionId + " · SHA-256：" + entry.context.identity.sha256 + "\n\n" : "")
        + (entry.context.textSource?.kind === "ocr" ? "文字来源：本机 OCR，未经人工核对。\n\n" : "")
        + quote.split("\n").map(line => "> " + line).join("\n")
        + (entry.question !== undefined ? "\n\n### 我的问题\n\n" + entry.question + "\n\n### 我的理解\n\n" : "\n\n### 我的理解与问题\n\n") + (entry.note || "（尚未填写）")
        + "\n\n状态：" + entry.status + (pending.has(entry.id) ? "（含当前未保存的草稿）" : "") + "\n";
    }).join("\n---\n\n");
    const name = "共读笔记-" + new Date().toISOString().slice(0, 10) + ".md";
    exportButton.disabled = true;
    try {
      if (host.getHostCapabilities()?.downloadFile) {
        const result = await host.downloadFile({contents: [{type: "resource", resource: {uri: "file:///" + encodeURIComponent(name), mimeType: "text/markdown", blob: uint8ArrayToBase64(new TextEncoder().encode(markdown))}}]});
        if (result.isError) throw new Error("客户端未接受导出，笔记仍保留在本机。");
        status.textContent = "已将笔记导出请求交给客户端。";
      } else {
        const url = URL.createObjectURL(new Blob([markdown], {type: "text/markdown;charset=utf-8"}));
        const link = document.createElement("a"); link.href = url; link.download = name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        status.textContent = "已发起笔记下载。";
      }
    } catch (error) { status.textContent = "导出未完成：" + message(error); }
    finally { exportButton.disabled = !visibleIds.size; }
  });
  window.addEventListener("beforeunload", event => { if (pending.size || questionDraft && questionInput.value.trim()) { event.preventDefault(); event.returnValue = ""; } });
  document.addEventListener("selectionchange", () => {
    // Editing a note should not replace a captured source selection.
    if (!(document.activeElement instanceof HTMLTextAreaElement && container.contains(document.activeElement))) refresh();
  });
  window.addEventListener("storage", event => {
    if (event.storageArea !== localStorage || (event.key !== key && event.key !== null)) return;
    try {
      const latest = readStored();
      mergeStoredEntries(latest);
      const active = document.activeElement instanceof HTMLTextAreaElement && list.contains(document.activeElement) ? document.activeElement : null;
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
