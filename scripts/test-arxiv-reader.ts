import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { chromium, expect } from "@playwright/test";
import { ArxivClient, ArxivService } from "../arxiv";
import { atomFeed } from "../tests/helpers/arxiv-fixture";
import { createServer, createLibrary, RESOURCE_URI, stopFileWatch } from "../server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "tests/.artifacts");
await fs.mkdir(artifacts, { recursive: true });
const directory = await fs.mkdtemp(path.join(artifacts, "library-test-"));
const fixture = path.join(root, "tests/fixtures/reader-smoke.pdf");
let library = createLibrary(directory);
const arxivBytes = await fs.readFile(fixture);
const requested: string[] = [];
let pdfMode = "normal";
const arxiv = new ArxivService(library, new ArxivClient((async (input: any, init?: RequestInit) => {
  const url = new URL(String(input)); requested.push(url.href);
  if (url.pathname === "/api/query") return new Response(atomFeed([url.searchParams.get("id_list") ?? "1706.03762v2"], "Test &amp; paper"));
  if (pdfMode === "slow") await new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  return new Response(arxivBytes, { headers: { "content-type": "application/pdf", "content-length": String(arxivBytes.length) } });
}) as typeof fetch, 0));
let server = createServer({ enableInteract: true, library, arxiv });
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
    const result = await client.callTool(params);
    if (params.name === "display_pdf" && result._meta?.viewUUID) viewIds.add(String(result._meta.viewUUID));
    return Response.json(result);
  }
  return new Response("Not found", { status: 404 });
} });
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
let context = await browser.newContext({ viewport: { width: 380, height: 850 } });
let page = await context.newPage();
let view = page.frameLocator("iframe");
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(15000);
const base = `http://127.0.0.1:${http.port}/`;

try {
  await page.goto(base);
  await expect(view.locator("#arxiv-panel")).toBeVisible();
  await view.getByText("从 arXiv 找论文", { exact: true }).click();
  await view.locator("#arxiv-query").fill("attention");
  await view.locator("#arxiv-search-form button").click();
  await expect(view.locator("#arxiv-results")).toContainText("Test & paper");
  await expect(view.locator("#arxiv-results")).toContainText("1706.03762v2");
  await view.getByLabel("1706.03762 版本", { exact: true }).fill("1");
  await view.locator("#arxiv-results").getByRole("button", { name: "下载入库" }).click();
  await expect(view.locator("#arxiv-jobs")).toContainText("已入库", { timeout: 15000 });
  await expect(view.locator("#library-list")).toContainText("1706.03762v1");
  const first = library.list()[0];
  assert.equal(first.source?.version, 1);
  assert.ok(requested.includes("https://arxiv.org/pdf/1706.03762v1"));
  await page.screenshot({ path: path.join(artifacts, "arxiv-sidebar.png") });
  await view.locator("#arxiv-jobs").getByRole("button", { name: "打开论文" }).click();
  await expect(view.locator("#text-layer")).toContainText("Alpha unique");
  await page.frames().find(f => f.url().endsWith("/app"))!.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector("#text-layer span")!);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await view.locator("#explain-selection-btn").click();
  await expect.poll(() => page.evaluate(() => (window as any).observations.messages.length)).toBe(1);
  const message = await page.evaluate(() => (window as any).observations.messages[0].content[0].text);
  assert.ok(message.includes("https://arxiv.org/abs/1706.03762v1"));
  assert.ok(message.includes(first.versionId));
  console.log("PASS search, choose v1, background import, sidebar opening and version-pinned question provenance");
  await view.locator("#library-home").click();
  await expect(view.locator("#arxiv-panel")).toBeVisible();
  await view.locator("#arxiv-results").getByRole("button", { name: "下载入库" }).click();
  await expect(view.locator("#library-list .library-item")).toHaveCount(1);
  assert.equal(arxiv.list().length, 1);
  console.log("PASS repeated version download reuses the existing job and library asset");

  pdfMode = "slow";
  await view.getByLabel("1706.03762 版本", { exact: true }).fill("2");
  await view.locator("#arxiv-results").getByRole("button", { name: "下载入库" }).click();
  await expect(view.locator("#arxiv-jobs")).toContainText("下载中", { timeout: 15000 });
  await view.locator("#arxiv-jobs").getByRole("button", { name: "取消", exact: true }).click();
  await expect(view.locator("#arxiv-jobs")).toContainText("已取消");
  pdfMode = "normal";
  await view.locator("#arxiv-jobs").getByRole("button", { name: "重新下载", exact: true }).click();
  await expect.poll(() => library.list().length).toBe(2);
  await view.locator("#arxiv-jobs-refresh").click();
  await expect(view.locator("#library-list .library-item")).toHaveCount(2);
  assert.equal(new Set(library.list().map(a => a.documentId)).size, 1);
  assert.equal(new Set(library.list().map(a => a.versionId)).size, 2);
  console.log("PASS cancellation, manual retry and independent v1/v2 assets under one paper");
  assert.deepEqual(errors, []);
  assert.ok(await page.frames().find(f => f.url().endsWith("/app"))!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  console.log("arXiv sidebar checks passed; network responses are fixtures, MCP/PDF/SQLite/browser are real.");
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, "arxiv-failure.png") }).catch(() => {}); throw error;
} finally {
  await browser.close(); http.stop(true);
  for (const id of viewIds) stopFileWatch(id);
  await client.close(); await server.close(); await arxiv.close(); library.close(); Bun.gc(true);
  assert.ok(directory.startsWith(path.join(artifacts, "library-test-")));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
