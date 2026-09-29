import type { ReadingContext } from "./reading-context.js";
/** Use the actual DOM boundaries, never a text search, for a live PDF selection. */
export function withSelectionRange(context: ReadingContext, layer: HTMLElement, range: Range): ReadingContext {
  if (!context.selection || !layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return context;
  const before = range.cloneRange(), after = range.cloneRange();
  before.selectNodeContents(layer); before.setEnd(range.startContainer, range.startOffset);
  after.selectNodeContents(layer); after.setStart(range.endContainer, range.endOffset);
  const text = (part: Range) => {
    const fragment = part.cloneContents();
    for (const br of fragment.querySelectorAll("br")) br.replaceWith("\n");
    return (fragment.textContent ?? "").replace(/\s+/g, " ");
  };
  return { ...context, selection: { ...context.selection,
    contextBefore: text(before).slice(-800),
    contextAfter: text(after).slice(0, 800),
    nearbyTextStatus: "anchored",
  } };
}
