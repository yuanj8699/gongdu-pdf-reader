import type { PDFDocumentProxy } from "pdfjs-dist";
import "./reader-navigation.css";

type PdfOutlineItem = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];
type NavigationTab = "outline" | "bookmarks";

interface OutlineEntry {
  id: string;
  title: string;
  page: number | null;
  children: OutlineEntry[];
  parent: OutlineEntry | null;
  initiallyExpanded: boolean;
  row?: HTMLElement;
  button?: HTMLButtonElement;
}

interface Bookmark {
  page: number;
  title: string;
}

export interface ReaderNavigationOptions {
  /** An empty element placed before the canvas in the reader's flex row. */
  container: HTMLElement;
  /** Pages are one-based, like the viewer's page input. */
  goToPage: (page: number) => void | Promise<void>;
  getCurrentPage: () => number;
  onLayoutChange?: () => void;
  onExpandedChange?: (expanded: boolean) => void;
}

export interface ReaderNavigation {
  /** Use a document fingerprint or canonical URI, never a per-tool-call ID. */
  load: (document: PDFDocumentProxy, documentKey: string) => Promise<void>;
  setCurrentPage: (page: number) => void;
  /** Clears this view, without deleting this document's saved bookmarks. */
  clear: () => void;
  setExpanded: (expanded: boolean) => void;
  readonly expanded: boolean;
  destroy: () => void;
}

const STORAGE_PREFIX = "pdf-reader:bookmarks:v1:";
let navigationCount = 0;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string): HTMLButtonElement {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}

/** The destinations in PDF.js are zero-based page indices or indirect refs. */
async function destinationPage(
  pdf: PDFDocumentProxy,
  destination: PdfOutlineItem["dest"],
): Promise<number | null> {
  const explicit =
    typeof destination === "string"
      ? await pdf.getDestination(destination)
      : destination;
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const reference: unknown = explicit[0];
  let index: number;
  if (typeof reference === "number" && Number.isInteger(reference)) {
    index = reference;
  } else if (
    reference !== null &&
    typeof reference === "object" &&
    "num" in reference &&
    "gen" in reference &&
    typeof reference.num === "number" &&
    typeof reference.gen === "number"
  ) {
    index = await pdf.getPageIndex({ num: reference.num, gen: reference.gen });
  } else {
    return null;
  }
  return index >= 0 && index < pdf.numPages ? index + 1 : null;
}

export function createReaderNavigation(
  options: ReaderNavigationOptions,
): ReaderNavigation {
  const { container } = options;
  const id = `reader-navigation-${++navigationCount}`;
  const narrowScreen = window.matchMedia("(max-width: 700px)");
  let expanded = !narrowScreen.matches;
  let selectedTab: NavigationTab = "outline";
  let generation = 0;
  let pdf: PDFDocumentProxy | null = null;
  let storageKey: string | null = null;
  let currentPage = 1;
  let outline: OutlineEntry[] = [];
  let entries: OutlineEntry[] = [];
  let bookmarks: Bookmark[] = [];

  container.classList.add("reader-navigation");
  container.setAttribute("role", "navigation");
  container.setAttribute("aria-label", "阅读导航");
  const toggle = button("reader-navigation-toggle", "");
  toggle.setAttribute("aria-label", "目录与书签");
  toggle.setAttribute("aria-controls", `${id}-body`);
  const toggleIcon = element("span", "reader-navigation-icon", "☰");
  toggleIcon.setAttribute("aria-hidden", "true");
  toggle.append(toggleIcon, element("span", "reader-navigation-label", "目录与书签"));
  const toggleChevron = element("span", "reader-navigation-chevron", "‹");
  toggleChevron.setAttribute("aria-hidden", "true");
  toggle.append(toggleChevron);

  const body = element("div", "reader-navigation-body");
  body.id = `${id}-body`;
  const mobileHeader = element("div", "reader-navigation-mobile-header");
  mobileHeader.append(element("span", "", "目录与书签"));
  const closeButton = button("reader-navigation-close", "×");
  closeButton.setAttribute("aria-label", "收起目录与书签");
  mobileHeader.append(closeButton);

  const tabList = element("div", "reader-navigation-tabs");
  tabList.setAttribute("role", "tablist");
  tabList.setAttribute("aria-label", "阅读导航类型");
  const outlineTab = button("reader-navigation-tab", "目录");
  const bookmarksTab = button("reader-navigation-tab", "书签");
  const outlinePanel = element("div", "reader-navigation-panel");
  const bookmarksPanel = element("div", "reader-navigation-panel");
  const tabs = { outline: outlineTab, bookmarks: bookmarksTab };
  const panels = { outline: outlinePanel, bookmarks: bookmarksPanel };
  for (const name of ["outline", "bookmarks"] as const) {
    const tab = tabs[name];
    const panel = panels[name];
    tab.id = `${id}-${name}-tab`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `${id}-${name}`);
    panel.id = `${id}-${name}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.tabIndex = 0;
    tab.addEventListener("click", () => selectTab(name));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? "outline"
          : event.key === "End"
            ? "bookmarks"
            : name === "outline"
              ? "bookmarks"
              : "outline";
      selectTab(next);
      tabs[next].focus();
    });
    tabList.append(tab);
  }

  const outlineMessage = element("p", "reader-navigation-empty");
  const outlineList = element("ul", "reader-outline-list");
  outlineList.setAttribute("aria-label", "PDF 章节");
  outlinePanel.append(outlineMessage, outlineList);
  const bookmarkActions = element("div", "reader-bookmark-actions");
  const addBookmarkButton = button("reader-bookmark-add", "+ 添加当前页");
  addBookmarkButton.setAttribute("aria-label", "添加当前页书签");
  bookmarkActions.append(addBookmarkButton);
  const bookmarkMessage = element("p", "reader-navigation-empty");
  const bookmarkList = element("ul", "reader-bookmark-list");
  bookmarkList.setAttribute("aria-label", "本机书签");
  const storageNote = element(
    "p",
    "reader-bookmark-storage-note",
    "书签仅保存在此设备的浏览器中。",
  );
  const storageError = element("p", "reader-navigation-notice");
  storageError.setAttribute("role", "status");
  storageError.hidden = true;
  bookmarksPanel.append(
    bookmarkActions,
    bookmarkMessage,
    bookmarkList,
    storageNote,
    storageError,
  );
  const announcement = element("p", "reader-navigation-sr-only");
  announcement.setAttribute("role", "status");
  announcement.setAttribute("aria-live", "polite");
  body.append(mobileHeader, tabList, outlinePanel, bookmarksPanel, announcement);
  container.replaceChildren(toggle, body);

  function selectTab(name: NavigationTab) {
    selectedTab = name;
    for (const key of ["outline", "bookmarks"] as const) {
      tabs[key].setAttribute("aria-selected", String(key === name));
      tabs[key].tabIndex = key === name ? 0 : -1;
      panels[key].hidden = key !== name;
    }
  }

  function setExpanded(value: boolean) {
    const changed = expanded !== value;
    expanded = value;
    if (!value && body.contains(document.activeElement)) toggle.focus();
    container.classList.toggle("is-collapsed", !value);
    toggle.setAttribute("aria-expanded", String(value));
    toggle.title = value ? "收起目录与书签" : "展开目录与书签";
    body.hidden = !value;
    if (changed && value && narrowScreen.matches) tabs[selectedTab].focus();
    if (changed) {
      options.onExpandedChange?.(value);
      options.onLayoutChange?.();
    }
  }

  function setStorageError(message: string) {
    storageError.textContent = message;
    storageError.hidden = !message;
  }

  function restoreBookmarks() {
    bookmarks = [];
    setStorageError("");
    if (!storageKey || !pdf) return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) return;
      const parsed: unknown = JSON.parse(saved);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("version" in parsed) ||
        parsed.version !== 1 ||
        !("bookmarks" in parsed) ||
        !Array.isArray(parsed.bookmarks)
      ) {
        throw new Error("Invalid bookmark format");
      }
      const pages = new Set<number>();
      for (const savedBookmark of parsed.bookmarks) {
        if (
          !savedBookmark ||
          typeof savedBookmark !== "object" ||
          !Number.isInteger(savedBookmark.page) ||
          savedBookmark.page < 1 ||
          savedBookmark.page > pdf.numPages ||
          typeof savedBookmark.title !== "string" ||
          pages.has(savedBookmark.page)
        ) continue;
        pages.add(savedBookmark.page);
        bookmarks.push({
          page: savedBookmark.page,
          title: savedBookmark.title.trim().slice(0, 200) || `第 ${savedBookmark.page} 页`,
        });
      }
      bookmarks.sort((a, b) => a.page - b.page);
    } catch (error) {
      console.warn("[PDF navigation] Could not restore bookmarks", error);
      setStorageError("无法读取本机书签。新书签可在本次阅读中使用。");
    }
  }

  function persistBookmarks() {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, bookmarks }));
      setStorageError("");
    } catch (error) {
      console.warn("[PDF navigation] Could not save bookmarks", error);
      setStorageError("浏览器未能保存书签；本次改动仅在当前阅读中有效。");
    }
  }

  function currentEntry(page: number): OutlineEntry | null {
    let active: OutlineEntry | null = null;
    for (const entry of entries) {
      if (entry.page !== null && entry.page <= page && (!active || entry.page >= active.page!)) {
        active = entry;
      }
    }
    return active;
  }

  function setCurrentPage(page: number) {
    currentPage = page;
    const active = currentEntry(page);
    const ancestors = new Set<OutlineEntry>();
    for (let parent = active?.parent; parent; parent = parent.parent) ancestors.add(parent);
    for (const entry of entries) {
      entry.row?.classList.toggle("is-current", entry === active);
      entry.row?.classList.toggle("contains-current", ancestors.has(entry));
      if (entry === active) entry.button?.setAttribute("aria-current", "location");
      else entry.button?.removeAttribute("aria-current");
    }
    for (const jump of bookmarkList.querySelectorAll<HTMLButtonElement>("[data-bookmark-page]")) {
      if (Number(jump.dataset.bookmarkPage) === page) jump.setAttribute("aria-current", "page");
      else jump.removeAttribute("aria-current");
    }
    const bookmarked = bookmarks.some((item) => item.page === page);
    addBookmarkButton.disabled = !pdf || bookmarked;
    addBookmarkButton.textContent = bookmarked ? "✓ 当前页已有书签" : "+ 添加当前页";
  }

  async function navigate(page: number) {
    const navigationGeneration = generation;
    try {
      await options.goToPage(page);
      if (navigationGeneration !== generation) return;
      setCurrentPage(options.getCurrentPage());
      if (narrowScreen.matches) setExpanded(false);
    } catch (error) {
      if (navigationGeneration !== generation) return;
      console.warn("[PDF navigation] Could not navigate", error);
      announcement.textContent = `无法跳转至第 ${page} 页。请重试。`;
    }
  }

  function renderOutline(items: OutlineEntry[], list: HTMLUListElement) {
    for (const entry of items) {
      const item = element("li", "reader-outline-item");
      const row = element("div", "reader-outline-row");
      entry.row = row;
      let childList: HTMLUListElement | null = null;
      if (entry.children.length) {
        childList = element("ul", "reader-outline-list reader-outline-children");
        childList.id = `${id}-${entry.id}-children`;
        childList.hidden = !entry.initiallyExpanded;
        const disclosure = button("reader-outline-disclosure", "");
        const chevron = element("span", "reader-outline-chevron", "›");
        chevron.setAttribute("aria-hidden", "true");
        disclosure.append(chevron);
        disclosure.setAttribute("aria-label", `展开或收起“${entry.title}”`);
        disclosure.setAttribute("aria-controls", childList.id);
        disclosure.setAttribute("aria-expanded", String(!childList.hidden));
        const children = childList;
        disclosure.addEventListener("click", () => {
          children.hidden = !children.hidden;
          disclosure.setAttribute("aria-expanded", String(!children.hidden));
        });
        row.append(disclosure);
      } else {
        const spacer = element("span", "reader-outline-spacer");
        spacer.setAttribute("aria-hidden", "true");
        row.append(spacer);
      }

      const label = element("span", "reader-navigation-item-title", entry.title);
      if (entry.page !== null) {
        const page = entry.page;
        const jump = button("reader-outline-jump", "");
        jump.dataset.page = String(page);
        jump.setAttribute("aria-label", `跳转至第 ${page} 页：${entry.title}`);
        jump.title = `${entry.title} · 第 ${page} 页`;
        jump.append(label, element("span", "reader-navigation-page", String(page)));
        jump.addEventListener("click", () => void navigate(page));
        entry.button = jump;
        row.append(jump);
      } else {
        const text = element("span", "reader-outline-unlinked");
        text.title = "此目录项没有可跳转的本文件页码";
        text.append(label);
        row.append(text);
      }
      item.append(row);
      if (childList) {
        renderOutline(entry.children, childList);
        item.append(childList);
      }
      list.append(item);
    }
  }

  function renderBookmarks() {
    bookmarkList.replaceChildren();
    bookmarkMessage.textContent = pdf
      ? "还没有书签。遇到想再读的页面，可以添加当前页。"
      : "打开 PDF 后，可在这里保存常用页面。";
    bookmarkMessage.hidden = bookmarks.length > 0;
    bookmarks.forEach((bookmark, index) => {
      const item = element("li", "reader-bookmark-item");
      const jump = button("reader-bookmark-jump", "");
      jump.dataset.bookmarkPage = String(bookmark.page);
      jump.setAttribute("aria-label", `跳转至第 ${bookmark.page} 页：${bookmark.title}`);
      jump.title = `${bookmark.title} · 第 ${bookmark.page} 页`;
      jump.append(
        element("span", "reader-navigation-item-title", bookmark.title),
        element("span", "reader-navigation-page", String(bookmark.page)),
      );
      jump.addEventListener("click", () => void navigate(bookmark.page));
      const remove = button("reader-bookmark-remove", "×");
      remove.setAttribute("aria-label", `删除第 ${bookmark.page} 页书签`);
      remove.title = `删除第 ${bookmark.page} 页书签`;
      remove.addEventListener("click", () => {
        bookmarks = bookmarks.filter((item) => item.page !== bookmark.page);
        persistBookmarks();
        renderBookmarks();
        const remaining = bookmarkList.querySelectorAll<HTMLButtonElement>("[data-bookmark-page]");
        (remaining[Math.min(index, remaining.length - 1)] ?? addBookmarkButton).focus();
        announcement.textContent = `已删除第 ${bookmark.page} 页书签。`;
      });
      item.append(jump, remove);
      bookmarkList.append(item);
    });
    setCurrentPage(currentPage);
  }

  addBookmarkButton.addEventListener("click", () => {
    if (!pdf) return;
    const page = options.getCurrentPage();
    if (bookmarks.some((bookmark) => bookmark.page === page)) return;
    const title = currentEntry(page)?.title ?? `第 ${page} 页`;
    bookmarks.push({ page, title: title.slice(0, 200) });
    bookmarks.sort((a, b) => a.page - b.page);
    currentPage = page;
    persistBookmarks();
    renderBookmarks();
    bookmarkList.querySelector<HTMLButtonElement>(`[data-bookmark-page="${page}"]`)?.focus();
    announcement.textContent = `已添加第 ${page} 页书签。`;
  });

  function clear() {
    generation++;
    pdf = null;
    storageKey = null;
    outline = [];
    entries = [];
    bookmarks = [];
    currentPage = 1;
    outlineList.replaceChildren();
    outlinePanel.removeAttribute("aria-busy");
    outlineMessage.textContent = "打开 PDF 后显示章节目录。";
    outlineMessage.hidden = false;
    setStorageError("");
    announcement.textContent = "";
    renderBookmarks();
  }

  async function load(document: PDFDocumentProxy, documentKey: string) {
    if (!documentKey.trim()) throw new Error("Reader navigation requires a stable document key");
    clear();
    pdf = document;
    storageKey = STORAGE_PREFIX + encodeURIComponent(documentKey);
    currentPage = options.getCurrentPage();
    restoreBookmarks();
    renderBookmarks();
    outlineMessage.textContent = "正在读取章节目录…";
    outlinePanel.setAttribute("aria-busy", "true");
    const loadGeneration = generation;
    try {
      const source = await document.getOutline();
      if (generation !== loadGeneration) return;
      let unresolved = 0;
      let nextId = 0;
      const build = async (
        items: PdfOutlineItem[],
        parent: OutlineEntry | null,
      ): Promise<OutlineEntry[]> => {
        const result: OutlineEntry[] = [];
        for (const item of items) {
          if (generation !== loadGeneration) return result;
          let page: number | null = null;
          try {
            page = await destinationPage(document, item.dest);
          } catch (error) {
            console.warn("[PDF navigation] Could not resolve outline destination", error);
          }
          if (item.dest !== null && page === null) unresolved++;
          const entry: OutlineEntry = {
            id: `entry-${nextId++}`,
            title: item.title.trim() || "未命名章节",
            page,
            children: [],
            parent,
            initiallyExpanded: (item.count ?? 0) >= 0,
          };
          entry.children = await build(item.items, entry);
          result.push(entry);
        }
        return result;
      };
      const resolved = await build(source ?? [], null);
      if (generation !== loadGeneration) return;
      outline = resolved;
      const flatten = (items: OutlineEntry[]): OutlineEntry[] =>
        items.flatMap((item) => [item, ...flatten(item.children)]);
      entries = flatten(outline);
      renderOutline(outline, outlineList);
      outlineMessage.textContent = outline.length
        ? unresolved ? "部分目录项无法跳转，仍可使用页码导航。" : ""
        : "此 PDF 未提供章节目录。你可以使用页码导航，或添加自己的书签。";
      outlineMessage.hidden = Boolean(outline.length && !unresolved);
      setCurrentPage(options.getCurrentPage());
    } catch (error) {
      if (generation !== loadGeneration) return;
      console.warn("[PDF navigation] Could not load outline", error);
      outlineMessage.textContent = "无法读取此 PDF 的目录。你仍可使用页码导航和书签。";
      outlineMessage.hidden = false;
    } finally {
      if (generation === loadGeneration) outlinePanel.removeAttribute("aria-busy");
    }
  }

  const handleKeyboard = (event: KeyboardEvent) => {
    // Keep the viewer's global page/annotation shortcuts out of this widget;
    // native Space/Enter button activation and Tab traversal still work.
    if ([" ", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Delete", "Backspace"].includes(event.key)) {
      if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
    }
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
      toggle.focus();
    }
  };
  const handleScreenChange = () => {
    if (narrowScreen.matches && expanded) setExpanded(false);
    else options.onLayoutChange?.();
  };
  toggle.addEventListener("click", () => setExpanded(!expanded));
  closeButton.addEventListener("click", () => setExpanded(false));
  container.addEventListener("keydown", handleKeyboard);
  narrowScreen.addEventListener("change", handleScreenChange);
  selectTab(selectedTab);
  setExpanded(expanded);
  clear();

  return {
    load,
    setCurrentPage,
    clear,
    setExpanded,
    get expanded() { return expanded; },
    destroy() {
      clear();
      container.removeEventListener("keydown", handleKeyboard);
      narrowScreen.removeEventListener("change", handleScreenChange);
      container.replaceChildren();
      container.classList.remove("reader-navigation", "is-collapsed");
      container.removeAttribute("role");
      container.removeAttribute("aria-label");
    },
  };
}
