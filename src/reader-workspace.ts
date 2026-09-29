import type { LibraryAsset } from "./library-types.js";
import "./reader-workspace.css";

/** Keep the existing readers and repository navigator mounted when switching files. */
export function createReaderWorkspace() {
  const workspace = document.createElement("div");
  workspace.id = "reading-workspace";
  workspace.innerHTML = `<aside id="repository-navigation" aria-label="仓库目录" hidden></aside><div id="reader-stage"></div>`;
  document.getElementById("library-panel")!.after(workspace);
  const stage = workspace.querySelector<HTMLElement>("#reader-stage")!;
  for (const id of ["text-reader", "loading", "error", "viewer"]) stage.append(document.getElementById(id)!);
  const dock = workspace.querySelector<HTMLElement>("#repository-navigation")!;
  const toggle = document.createElement("button");
  toggle.type = "button"; toggle.textContent = "仓库目录"; toggle.hidden = true;
  toggle.setAttribute("aria-controls", dock.id);
  document.getElementById("library-home")!.after(toggle);
  let collapsed = false, reading = false;
  const narrow = window.matchMedia("(max-width: 680px)");
  function renderNavigation() {
    workspace.classList.toggle("navigation-open", !collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    dock.hidden = toggle.hidden || collapsed;
    stage.inert = narrow.matches && !dock.hidden;
  }
  toggle.addEventListener("click", () => { collapsed = !collapsed; renderNavigation(); });
  narrow.addEventListener("change", () => { collapsed = narrow.matches; renderNavigation(); });
  workspace.parentElement!.addEventListener("keydown", event => {
    if (event.key === "Escape" && narrow.matches && !dock.hidden) {
      event.preventDefault(); event.stopPropagation();
      collapsed = true; renderNavigation(); toggle.focus();
    }
  });
  return {
    dock,
    show(asset?: LibraryAsset) {
      workspace.hidden = false;
      toggle.hidden = !asset?.githubSource;
      if (!reading || narrow.matches) collapsed = narrow.matches;
      reading = true;
      renderNavigation();
      if (narrow.matches) { stage.tabIndex = -1; stage.focus({ preventScroll: true }); }
    },
    hide() { workspace.hidden = true; toggle.hidden = true; reading = false; },
  };
}
