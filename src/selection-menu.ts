/** One contextual action shared by the PDF and text readers. */
export function createSelectionMenu() {
  const menu = document.createElement("div");
  menu.id = "selection-context-menu"; menu.hidden = true;
  menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "选中原文操作");
  const button = document.createElement("button");
  button.type = "button"; button.setAttribute("role", "menuitem"); button.textContent = "向 GPT 提问";
  menu.append(button); document.body.append(menu);
  let action: (() => void) | null = null;
  function close() { menu.hidden = true; action = null; }
  button.addEventListener("pointerdown", event => event.preventDefault());
  button.addEventListener("click", () => { const send = action; close(); send?.(); });
  document.addEventListener("pointerdown", event => { if (!menu.contains(event.target as Node)) close(); }, true);
  document.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);
  document.addEventListener("keydown", event => {
    if (menu.hidden) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); button.focus({ preventScroll: true });
    } else if (event.key === "Tab") close();
  }, true);
  return {
    close,
    show(event: MouseEvent, send: () => void) {
      event.preventDefault(); action = send; menu.hidden = false;
      const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
      const x = event.clientX || range?.left || 8, y = event.clientY || range?.bottom || 8;
      menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + "px";
      menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + "px";
      button.focus({ preventScroll: true });
    },
  };
}
