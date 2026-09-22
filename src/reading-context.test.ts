import { describe, expect, it } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { HostBridge } from "./host-bridge.js";
import { assertReferenceTarget, createReadingContext, withNearbyText } from "./reading-context.js";

const base = () => createReadingContext({ uri: "library://asset-a", viewUUID: "window-a", title: "Book", pageNumber: 2,
  pageLabel: "iv", rotation: 90, text: "你好世界", rects: [{ x: 10, y: 20, width: 30, height: 8 }],
  asset: { documentId: "doc-a", versionId: "version-a", assetId: "asset-a", sha256: "hash-a", title: "Book",
    fileName: "book.pdf", pageCount: 3, byteLength: 100, fingerprint: "fingerprint", createdAt: "" } });
const target = { viewUUID: "window-a", documentId: "doc-a", versionId: "version-a", assetId: "asset-a" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe("reading references", () => {
  it("keeps printed labels separate from file pages and handles Chinese text-layer spacing", () => {
    const context = withNearbyText(base(), "前文 你好 世界 后文");
    expect(context.location).toMatchObject({ pageNumber: 2, pageLabel: "iv", rotation: 90 });
    expect(context.selection).toEqual({ text: "你好世界", contextBefore: "前文 ", contextAfter: " 后文" });
    expect(withNearbyText(base(), "unrelated page").selection?.contextBefore).toBe("");
  });
  it("rejects another window, document, version, asset or out-of-range page", () => {
    expect(() => assertReferenceTarget(target, base(), 3, 3)).not.toThrow();
    for (const key of ["viewUUID", "documentId", "versionId", "assetId"] as const) {
      expect(() => assertReferenceTarget({ ...target, [key]: "other" }, base(), 2, 3)).toThrow("版本不一致");
    }
    for (const page of [0, 4, 1.5]) expect(() => assertReferenceTarget(target, base(), page, 3)).toThrow("页码");
    const transient = createReadingContext({ uri: "https://example.org/paper.pdf", title: "PDF", pageNumber: 1, rotation: 0 });
    expect(transient.identity.kind).toBe("transient");
    expect(() => assertReferenceTarget(target, transient, 1, 3)).toThrow();
  });
});

describe("HostBridge boundary", () => {
  it("orders host updates, drops stale queued snapshots, and can clear library context", async () => {
    const first = deferred(), entered = deferred();
    const seen: unknown[] = [];
    const host = new HostBridge({ updateModelContext: async (params: unknown) => {
      seen.push(params); if (seen.length === 1) { entered.resolve(); await first.promise; } return {};
    } } as unknown as App);
    const a = host.updateContext({ structuredContent: { page: 1 } });
    await entered.promise;
    let current = true;
    const b = host.updateContext({ structuredContent: { page: 2 } }, () => current);
    current = false;
    const c = host.updateContext({ structuredContent: { readingContext: null } });
    first.resolve(); await Promise.all([a, b, c]);
    expect(seen).toEqual([{ structuredContent: { page: 1 } }, { structuredContent: { readingContext: null } }]);
  });
  it("a rejected context does not prevent the next update", async () => {
    let calls = 0;
    const host = new HostBridge({ updateModelContext: async () => { if (++calls === 1) throw new Error("host rejected"); return {}; } } as unknown as App);
    await expect(host.updateContext({})).rejects.toThrow("host rejected");
    await host.updateContext({}); expect(calls).toBe(2);
  });
  it("sends a fixed question snapshot even when reader state changes before acknowledgement", async () => {
    const pending = deferred();
    const messages: any[] = [];
    const host = new HostBridge({ sendMessage: async (params: unknown) => { messages.push(params); await pending.promise; return {}; } } as unknown as App);
    const context = base();
    const sending = host.ask(context, "解释这段");
    context.location.pageNumber = 3; context.selection!.text = "another selection";
    pending.resolve(); await sending;
    const text = messages[0].content[0].text;
    expect(text).toContain('"pageNumber":2'); expect(text).toContain("你好世界"); expect(text).not.toContain("another selection");
  });
  it("reports rejection and uncertain delivery without retrying", async () => {
    let calls = 0;
    const rejected = new HostBridge({ sendMessage: async () => { calls++; return { isError: true }; } } as unknown as App);
    await expect(rejected.ask(base(), "解释")).rejects.toThrow("未接受");
    const timedOut = new HostBridge({ sendMessage: async () => { calls++; throw new Error("request timeout"); } } as unknown as App);
    await expect(timedOut.ask(base(), "解释")).rejects.toThrow("未确认消息是否送达");
    expect(calls).toBe(2);
  });
});
