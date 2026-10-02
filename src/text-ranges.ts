type TextMatch = { start: number; end: number };
type DomPoint = { node: Node; offset: number };

/** Keep literal text and order; normalize only explicit whitespace. */
export function normalizeSearchText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Match normalized text without losing original UTF-16 offsets during casing. */
export function findTextMatches(normalizedText: string, query: string): TextMatch[] {
  const needle = normalizeSearchText(query).toLowerCase();
  if (!needle) return [];
  const folded = normalizedText.toLowerCase();
  const starts: number[] = [], ends: number[] = [];
  if (folded.length !== normalizedText.length) {
    let offset = 0;
    for (const character of normalizedText) {
      const length = character.toLowerCase().length;
      for (let i = 0; i < length; i++) {
        // An expanded lowercase character (such as İ → i + ◌̇) still
        // selects its one original character, including partial matches.
        starts.push(offset + (length === character.length ? i : 0));
        ends.push(offset + (length === character.length ? i + 1 : character.length));
      }
      offset += character.length;
    }
  }
  const matches: TextMatch[] = [];
  for (let position = 0; position < folded.length;) {
    const index = folded.indexOf(needle, position);
    if (index < 0) break;
    matches.push({
      start: starts.length ? starts[index] : index,
      end: ends.length ? ends[index + needle.length - 1] : index + needle.length,
    });
    position = index + 1;
  }
  return matches;
}

/** A snapshot of one rendered layer. Rebuild after its DOM is replaced. */
export function buildTextRangeIndex(layer: HTMLElement) {
  const document = layer.ownerDocument;
  const starts: DomPoint[] = [], ends: DomPoint[] = [];
  let text = "";
  let whitespaceStart: DomPoint | undefined, whitespaceEnd: DomPoint | undefined;
  function append(character: string, start: DomPoint, end: DomPoint) {
    if (/\s/.test(character)) {
      if (text) { whitespaceStart ??= start; whitespaceEnd = end; }
      return;
    }
    if (whitespaceStart) {
      text += " "; starts.push(whitespaceStart); ends.push(whitespaceEnd!);
      whitespaceStart = whitespaceEnd = undefined;
    }
    text += character; starts.push(start); ends.push(end);
  }
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent!;
      for (let offset = 0; offset < value.length; offset++) {
        append(value[offset], { node, offset }, { node, offset: offset + 1 });
      }
    } else if (node.nodeName === "BR") {
      const parent = node.parentNode!;
      const offset = Array.from(parent.childNodes).indexOf(node as ChildNode);
      append("\n", { node: parent, offset }, { node: parent, offset: offset + 1 });
    }
  }
  return {
    text,
    find(query: string): Array<TextMatch & { range: Range }> {
      return findTextMatches(text, query).map(match => {
        const start = starts[match.start], end = ends[match.end - 1];
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        return { ...match, range };
      });
    },
  };
}
