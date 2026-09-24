import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { chromium, expect } from "@playwright/test";
import { PDFDocument, StandardFonts, PDFName, degrees } from "@cantoo/pdf-lib";
import { allowedLocalFiles, createServer, createLibrary, RESOURCE_URI, stopFileWatch } from "../server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "tests/.artifacts");
await fs.mkdir(artifacts, { recursive: true });
const directory = await fs.mkdtemp(path.join(artifacts, "library-test-"));
const fixture = path.join(root, "tests/fixtures/reader-smoke.pdf");
const localSource = path.join(directory, "source");
await fs.mkdir(path.join(localSource, "nested"), { recursive: true });
await fs.copyFile(fixture, path.join(localSource, "nested", "book.pdf"));
await fs.writeFile(path.join(localSource, "broken.pdf"), "not a PDF");
allowedLocalFiles.add(fixture);
let library = createLibrary(directory);
let server = createServer({ enableInteract: true, library, localLibraryDirectories: [localSource] });
let client = new Client({ name: "library-browser-test", version: "1" });
async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
}
await connect();
const appResource = (await client.readResource({ uri: RESOURCE_URI })).contents[0];
assert.ok("text" in appResource);
const hostBuild = await Bun.build({ entrypoints: [path.join(root, "tests/host.ts")], target: "browser" });
assert.ok(hostBuild.success);
const hostScript = await hostBuild.outputs[0].text();
const viewIds = new Set<string>();
let rejectSave = false;
const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/") return new Response('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe title="PDF reader"></iframe><script type="module" src="/host.js"></script>', { headers: { "content-type": "text/html" } });
  if (url.pathname === "/host.js") return new Response(hostScript, { headers: { "content-type": "application/javascript" } });
  if (url.pathname === "/app") return new Response(appResource.text, { headers: { "content-type": "text/html" } });
  if (url.pathname === "/initial") {
    const result = url.searchParams.has("legacy")
      ? await client.callTool({ name: "display_pdf", arguments: { url: fixture } })
      : await client.callTool({ name: "open_library", arguments: {} });
    if (result._meta?.viewUUID) viewIds.add(String(result._meta.viewUUID));
    return Response.json(result);
  }
  if (url.pathname === "/tool") {
    const params = await request.json() as { name: string; arguments: Record<string, unknown> };
    if (params.name === "library_set_page" && params.arguments.page === 2 && rejectSave) {
      rejectSave = false;
      return Response.json({ isError: true, content: [{ type: "text", text: "模拟书库暂时不可写" }] });
    }
    const result = await client.callTool(params);
    if (params.name === "display_pdf" && result._meta?.viewUUID) viewIds.add(String(result._meta.viewUUID));
    return Response.json(result);
  }
  return new Response("Not found", { status: 404 });
} });
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
let context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
let page = await context.newPage();
let view = page.frameLocator("iframe");
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(15000);
const base = `http://127.0.0.1:${http.port}/`;
async function go(number: number) {
  await view.locator("#page-input").fill(String(number));
  await view.locator("#page-input").press("Enter");
  await expect(view.locator("#page-input")).toHaveValue(String(number));
}
async function selectFirstText() {
  await expect(view.locator("#text-layer span").first()).toBeVisible();
  return page.frames().find(f => f.url().endsWith("/app"))!.evaluate(() => {
    const span = document.querySelector("#text-layer span")!;
    const range = document.createRange(); range.selectNodeContents(span);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return selection.toString();
  });
}
const check = (name: string) => console.log(`PASS ${name}`);

try {
  await page.goto(`${base}?legacy=1`);
  await expect(view.locator("#text-layer")).toContainText("Alpha unique");
  await go(2);
  await view.getByRole("tab", { name: "书签", exact: true }).click();
  await view.getByRole("button", { name: "添加当前页书签", exact: true }).click();
  const legacyBefore = await page.frames().find(f => f.url().endsWith("/app"))!.evaluate(() =>
    Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes("bookmarks:v1:") || key.endsWith(":page"))));
  await view.locator("#library-home").click();
  await expect(view.locator("#library-list")).toContainText("书库还是空的");
  await view.locator("#library-file").setInputFiles(fixture);
  await expect(view.locator("#library-status")).toContainText("已加入书库");
  await view.locator("#library-file").setInputFiles(fixture);
  await expect(view.locator("#library-status")).toContainText("已加入书库");
  await expect(view.locator(".library-item")).toHaveCount(1);
  const asset = library.list()[0];
  await view.locator(".library-item button").click();
  await expect(view.locator("#page-input")).toHaveValue("2");
  await expect.poll(() => library.state(asset.assetId).page).toBe(2);
  assert.deepEqual(library.state(asset.assetId).bookmarks.map(b => b.page), [2]);
  const legacyAfter = await page.frames().find(f => f.url().endsWith("/app"))!.evaluate(() =>
    Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes("bookmarks:v1:") || key.endsWith(":page"))));
  assert.deepEqual(legacyAfter, legacyBefore);
  check("file-picker import, duplicate reuse, exact fingerprint migration, old storage retained");

  await view.getByRole("tab", { name: "书签", exact: true }).click();
  await view.getByRole("button", { name: "删除第 2 页书签", exact: true }).click();
  await expect.poll(() => library.state(asset.assetId).bookmarks.length).toBe(0);
  await go(3);
  await view.getByRole("button", { name: "添加当前页书签", exact: true }).click();
  await expect.poll(() => library.state(asset.assetId).bookmarks.map(b => b.page)).toEqual([3]);
  await view.locator("#library-home").click();
  await view.locator(".library-item button").click();
  await expect(view.locator("#page-input")).toHaveValue("3");
  assert.deepEqual(library.state(asset.assetId).bookmarks.map(b => b.page), [3]);
  check("bookmark deletion stays deleted when unchanged legacy data is offered again");

  rejectSave = true;
  await go(2);
  await expect(view.locator("#library-save-status")).toContainText("保存失败");
  await view.locator("#library-home").click();
  await expect(view.locator("#viewer")).toBeVisible();
  await view.locator("#library-retry-save").click();
  await expect(view.locator("#library-save-status")).toContainText("第 2 页已保存");
  await go(3);
  await expect(view.locator("#library-save-status")).toContainText("第 3 页已保存");
  check("failed page persistence is visible, retryable, and not reported as saved");

  const selected = await selectFirstText();
  await view.locator("#explain-selection-btn").click();
  await expect.poll(() => page.evaluate(() => (window as any).observations.messages.length)).toBe(1);
  const message = await page.evaluate(() => (window as any).observations.messages[0].content[0].text);
  for (const value of [selected, asset.documentId, asset.versionId, asset.assetId, "页码：3"]) assert.ok(message.includes(value), message);
  check("explicit selection question includes immutable document/version/asset identity and page");

  const questionContext = JSON.parse(message.slice(message.indexOf('{"schemaVersion"')));
  const activeView = questionContext.viewUUID;
  await expect.poll(() => page.evaluate(() => (window as any).observations.contexts.at(-1)?.structuredContent?.readingContext?.selection?.text)).toBe(selected);
  const automaticContext = await page.evaluate(() => (window as any).observations.contexts.at(-1).structuredContent.readingContext);
  const live = await client.callTool({ name: "interact", arguments: { viewUUID: activeView, action: "get_viewer_state" } });
  assert.ok(!live.isError, JSON.stringify(live));
  const liveState = JSON.parse((live.content as any[])[0].text);
  assert.deepEqual(liveState.readingContext, questionContext);
  assert.deepEqual(automaticContext, questionContext);
  assert.ok(questionContext.location.rects.length > 0);
  const target = { viewUUID: activeView, documentId: asset.documentId, versionId: asset.versionId, assetId: asset.assetId };
  for (const args of [
    { target: { ...target, versionId: crypto.randomUUID() }, location: { format: "pdf", pageNumber: 2 } },
    { target, location: { format: "pdf", pageNumber: 4 } },
  ]) {
    const rejected = await client.callTool({ name: "reader_navigate", arguments: args });
    assert.ok(rejected.isError, JSON.stringify(rejected));
    await expect(view.locator("#page-input")).toHaveValue("3");
  }
  const navigated = await client.callTool({ name: "reader_navigate", arguments: { target, location: { format: "pdf", pageNumber: 2 } } });
  assert.ok(!navigated.isError, JSON.stringify(navigated));
  assert.equal(navigated.structuredContent?.currentPage, 2);
  assert.equal((navigated.structuredContent?.readingContext as any).selection, null);
  await expect(view.locator("#text-layer")).toContainText("Beta unique");
  await client.callTool({ name: "reader_navigate", arguments: { target, location: { format: "pdf", pageNumber: 3 } } });
  await expect(view.locator("#text-layer")).toContainText("Gamma unique");
  check("automatic context, explicit question and live state share one snapshot; version-bound navigation acknowledges the page and rejects invalid references");

  const contextCount = await page.evaluate(() => (window as any).observations.contexts.length);
  await view.locator("#page-input").fill("2");
  // Trigger a re-render without moving keyboard focus out of the edited page field.
  await view.locator("#zoom-in-btn").evaluate(button => (button as HTMLButtonElement).click());
  await expect.poll(() => page.evaluate(() => (window as any).observations.contexts.length)).toBeGreaterThan(contextCount);
  await expect(view.locator("#page-input")).toHaveValue("2");
  await view.locator("#page-input").press("Enter");
  await expect(view.locator("#text-layer")).toContainText("Beta unique");
  await go(3);
  await expect(view.locator("#text-layer")).toContainText("Gamma unique");
  check("a render completing while the page field is focused preserves the user's unsubmitted page number");

  const secondPdf = await PDFDocument.create();
  const font = await secondPdf.embedFont(StandardFonts.Helvetica);
  const secondPage = secondPdf.addPage();
  secondPage.drawText("A different book with independent state", { x: 40, y: 740, font, size: 18 });
  secondPage.setRotation(degrees(90));
  secondPdf.catalog.set(PDFName.of("PageLabels"), secondPdf.context.obj({ Nums: [0, { S: PDFName.of("r"), St: 4 }] }));
  await view.locator("#library-home").click();
  await view.locator("#library-file").setInputFiles({ name: "second.pdf", mimeType: "application/pdf", buffer: Buffer.from(await secondPdf.save()) });
  await expect(view.locator(".library-item")).toHaveCount(2);
  const second = library.list().find(e => e.assetId !== asset.assetId)!;
  await view.locator(`.library-item[data-asset-id="${second.assetId}"] button`).click();
  await expect(view.locator("#text-layer")).toContainText("A different book");
  await expect(view.locator("#page-input")).toHaveValue("1");
  await expect(view.locator("#explain-selection-btn")).toBeDisabled();
  assert.deepEqual(library.state(second.assetId).bookmarks, []);
  const selectedSecond = await selectFirstText();
  await view.locator("#explain-selection-btn").click();
  await expect.poll(() => page.evaluate(() => (window as any).observations.messages.length)).toBe(2);
  const nextMessage = await page.evaluate(() => (window as any).observations.messages[1].content[0].text);
  assert.ok(nextMessage.includes(second.assetId) && nextMessage.includes(selectedSecond));
  assert.ok(!nextMessage.includes(asset.assetId));
  const rotatedContext = JSON.parse(nextMessage.slice(nextMessage.indexOf('{"schemaVersion"')));
  assert.equal(rotatedContext.location.rotation, 90);
  assert.equal(rotatedContext.location.pageNumber, 1);
  assert.equal(rotatedContext.location.pageLabel, "iv");
  assert.ok(rotatedContext.location.rects.every((r: any) => r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0));
  const wrongBook = await client.callTool({ name: "reader_navigate", arguments: {
    target: { ...target, viewUUID: rotatedContext.viewUUID }, location: { format: "pdf", pageNumber: 2 },
  } });
  assert.ok(wrongBook.isError, JSON.stringify(wrongBook));
  await expect(view.locator("#page-input")).toHaveValue("1");
  check("switching books clears old selection, page, bookmarks and question identity");

  await view.locator("#library-home").click();
  await view.locator("#library-file").setInputFiles({ name: "bad.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html>Not a PDF</html>") });
  await expect(view.locator("#library-status")).toContainText("导入失败");
  await expect(view.locator(".library-item")).toHaveCount(2);
  check("invalid PDF import fails visibly without adding a broken library item");

  await context.close();
  for (const id of viewIds) stopFileWatch(id);
  await client.close(); await server.close(); library.close();
  library = createLibrary(directory);
  server = createServer({ enableInteract: true, library, localLibraryDirectories: [localSource] });
  client = new Client({ name: "library-browser-restart", version: "1" });
  await connect();
  context = await browser.newContext({ viewport: { width: 380, height: 850 } });
  page = await context.newPage(); view = page.frameLocator("iframe");
  page.on("pageerror", e => errors.push(e.message)); page.setDefaultTimeout(15000);
  await page.goto(base);
  await expect(view.locator(".library-item")).toHaveCount(2);
  await page.screenshot({ path: path.join(artifacts, "library-sidebar.png") });
  await view.locator(`.library-item[data-asset-id="${asset.assetId}"] button`).click();
  await expect(view.locator("#page-input")).toHaveValue("3");
  await expect(view.locator("#text-layer")).toContainText("Gamma unique");
  await view.locator("#outline-toggle").click();
  await view.getByRole("tab", { name: "书签", exact: true }).click();
  await expect(view.locator('[data-bookmark-page="3"]')).toBeVisible();
  await expect(view.locator('[data-bookmark-page="2"]')).toHaveCount(0);
  await page.screenshot({ path: path.join(artifacts, "library-restored-bookmarks.png") });
  check("reopened SQLite plus fresh browser storage restores page and bookmarks in 380px sidebar");
  await view.locator("#outline-toggle").click();
  await view.locator("#fullscreen-btn").click();
  await expect(view.locator(".main")).toHaveClass(/fullscreen/);
  const zoom = view.getByRole("textbox", { name: "缩放百分比", exact: true });
  await zoom.fill("150%"); await zoom.press("Enter");
  await expect(zoom).toHaveValue("150%");
  await expect.poll(() => view.locator("#pdf-canvas").evaluate(el => el.getBoundingClientRect().width)).toBe(918);
  const leftEdge = await view.locator(".canvas-container").evaluate(el => {
    el.scrollLeft = 0;
    return el.querySelector(".page-wrapper")!.getBoundingClientRect().left - el.getBoundingClientRect().left;
  });
  assert.ok(leftEdge >= 0, "zoomed page left edge must remain reachable");
  await view.locator("#zoom-in-btn").click(); await expect(zoom).toHaveValue("175%");
  await view.locator("#zoom-out-btn").click(); await expect(zoom).toHaveValue("150%");
  await go(2); await expect(view.locator("#text-layer")).toContainText("Beta unique");
  await expect(zoom).toHaveValue("150%");
  await view.locator("#outline-toggle").click();
  await view.locator("#outline-toggle").click();
  await expect(zoom).toHaveValue("150%");
  await zoom.fill("oops"); await zoom.press("Enter"); await expect(zoom).toHaveValue("150%");
  await zoom.fill("900"); await zoom.press("Enter"); await expect(zoom).toHaveValue("300%");
  await expect(view.locator("#zoom-in-btn")).toBeDisabled();
  async function checkWheelScroll(mode: string) {
    const area = view.locator(".canvas-container");
    await area.evaluate(el => { el.scrollTop = 0; });
    const toolbarTop = (await view.locator(".zoom-bar").boundingBox())!.y;
    await area.hover();
    await page.mouse.wheel(0, 360);
    await expect.poll(() => area.evaluate(el => el.scrollTop)).toBeGreaterThan(200);
    await page.mouse.wheel(0, -360);
    await expect.poll(() => area.evaluate(el => el.scrollTop)).toBe(0);
    // Overscroll stays inside the reader; controls never travel with the page.
    await page.mouse.wheel(0, -600);
    await expect.poll(() => view.locator(".zoom-bar").boundingBox().then(box => box!.y)).toBe(toolbarTop);
    await expect.poll(() => area.evaluate(el => el.scrollTop)).toBe(0);
    check(`${mode}: real mouse wheel scrolls the PDF down/up while controls stay fixed`);
  }
  await checkWheelScroll("fullscreen sidebar");
  async function checkCtrlWheelZoom(mode: string) {
    const area = view.locator(".canvas-container");
    const initialClass = await view.locator(".main").getAttribute("class");
    const toolbarWidth = (await view.locator(".zoom-bar").boundingBox())!.width;
    const canvasWidth = () => view.locator("#pdf-canvas").evaluate(el => el.getBoundingClientRect().width);
    async function wheel(delta: number) {
      await area.hover();
      await page.keyboard.down("Control");
      try { await page.mouse.wheel(0, delta); }
      finally { await page.keyboard.up("Control"); }
    }
    await zoom.fill("100"); await zoom.press("Enter");
    await expect.poll(canvasWidth).toBe(612);
    await wheel(-100);
    await expect.poll(canvasWidth).toBeGreaterThan(612);
    const enlarged = await canvasWidth();
    await wheel(100);
    await expect.poll(canvasWidth).toBeLessThan(enlarged);
    await expect(zoom).toHaveValue("100%");
    // Both limits must work without exiting the sidebar or expanding inline.
    for (const [percent, delta] of [[300, -100], [50, 100]]) {
      await zoom.fill(String(percent)); await zoom.press("Enter");
      await expect.poll(canvasWidth).toBe(612 * percent / 100);
      await wheel(delta);
      await expect.poll(() => view.locator(".page-wrapper").evaluate(el => el.style.transform)).toBe("");
      await expect(zoom).toHaveValue(`${percent}%`);
      await expect(view.locator(".main")).toHaveAttribute("class", initialClass!);
    }
    assert.equal((await view.locator(".zoom-bar").boundingBox())!.width, toolbarWidth);
    await zoom.fill("150"); await zoom.press("Enter");
    await expect.poll(canvasWidth).toBe(918);
    check(`${mode}: real Ctrl+wheel zooms both directions, respects limits and preserves display mode`);
  }
  await checkCtrlWheelZoom("fullscreen sidebar");
  await view.locator(".canvas-container").evaluate(el => { el.scrollTop = 500; el.scrollLeft = 200; });
  const controls = await view.locator(".zoom-bar button, #zoom-level").evaluateAll(elements => elements.map(el => {
    const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  }));
  assert.ok(controls.every(Boolean), "all zoom controls must remain visible in the sidebar after scrolling");
  await page.screenshot({ path: path.join(artifacts, "reader-zoom-sidebar.png") });
  await page.setViewportSize({ width: 1400, height: 900 });
  await view.locator("#zoom-width-btn").click();
  await expect.poll(() => view.locator(".canvas-container").evaluate(el => {
    const css = getComputedStyle(el);
    const available = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    return Math.abs(el.querySelector("canvas")!.getBoundingClientRect().width - available);
  })).toBeLessThan(2);
  const widthZoom = await zoom.inputValue();
  await view.locator("#zoom-page-btn").click();
  await expect.poll(async () => parseFloat(await zoom.inputValue())).toBeLessThan(parseFloat(widthZoom));
  await expect.poll(() => view.locator(".canvas-container").evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThan(2);
  await page.screenshot({ path: path.join(artifacts, "reader-zoom-wide.png") });
  await go(3);
  await page.setViewportSize({ width: 380, height: 850 });
  await view.locator("#fullscreen-btn").click();
  await expect(view.locator(".main")).not.toHaveClass(/fullscreen/);
  await zoom.fill("150"); await zoom.press("Enter");
  await expect.poll(() => view.locator("#pdf-canvas").evaluate(el => el.getBoundingClientRect().width)).toBe(918);
  await checkWheelScroll("inline reader");
  await checkCtrlWheelZoom("inline reader");
  await expect(view.locator("#page-input")).toHaveValue("3");
  check("editable zoom, plus/minus, limits, navigation persistence, reachable page edges, fixed controls and width/page fit");
  await view.locator("#library-home").click();
  await expect(view.locator("#local-library-panel")).toBeVisible();
  await view.locator("#local-library-scan").click();
  await expect(view.locator("#local-library-status")).toContainText("找到 2 份 PDF");
  await view.locator("#local-library-import").click();
  await expect(view.locator("#local-library-status")).toContainText("1 份已就绪，1 份失败");
  await expect(view.locator(".library-item")).toHaveCount(2);
  assert.deepEqual(await fs.readFile(path.join(localSource, "nested", "book.pdf")), await fs.readFile(fixture));
  assert.equal(library.state(asset.assetId).page, 3);
  await fs.copyFile(fixture, path.join(localSource, "added.pdf"));
  await view.locator("#local-library-scan").click();
  await expect(view.locator("#local-library-files li")).toHaveCount(3);
  const layout = await page.frames().find(f => f.url().endsWith("/app"))!.evaluate(() => ({
    width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth,
  }));
  assert.ok(layout.content <= layout.width + 1, "folder controls overflow sidebar");
  await page.screenshot({ path: path.join(artifacts, "local-library-sidebar.png") });
  check("380px local-folder scan, batch partial failure, deduplication and rescan without changing source or progress");
  assert.deepEqual(errors, []);
  console.log("Library UI checks passed. Real PDF, SQLite and MCP; host messaging is simulated.");
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, "library-failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser.close(); http.stop(true);
  for (const id of viewIds) stopFileWatch(id);
  await client.close(); await server.close(); library.close();
  // Bun's SQLite statements can retain native handles until finalization on Windows.
  Bun.gc(true);
  assert.ok(directory.startsWith(path.join(artifacts, "library-test-")));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
