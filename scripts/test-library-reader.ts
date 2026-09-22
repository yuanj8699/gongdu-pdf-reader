import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { chromium, expect } from "@playwright/test";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { allowedLocalFiles, createServer, createLibrary, RESOURCE_URI, stopFileWatch } from "../server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "tests/.artifacts");
await fs.mkdir(artifacts, { recursive: true });
const directory = await fs.mkdtemp(path.join(artifacts, "library-test-"));
const fixture = path.join(root, "tests/fixtures/reader-smoke.pdf");
allowedLocalFiles.add(fixture);
let library = createLibrary(directory);
let server = createServer({ enableInteract: true, library });
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

  const secondPdf = await PDFDocument.create();
  const font = await secondPdf.embedFont(StandardFonts.Helvetica);
  secondPdf.addPage().drawText("A different book with independent state", { x: 40, y: 740, font, size: 18 });
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
  server = createServer({ enableInteract: true, library });
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
