import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { chromium, expect } from "@playwright/test";
import { GitHubClient, GitHubService } from "../github";
import { githubFixture, commitA } from "../tests/helpers/github-fixture";
import { createServer, createLibrary, RESOURCE_URI, stopFileWatch } from "../server";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "tests/.artifacts");
await fs.mkdir(artifacts, { recursive: true });
const directory = await fs.mkdtemp(path.join(artifacts, "library-test-"));
const fixture = path.join(root, "tests/fixtures/reader-smoke.pdf");
const library = createLibrary(directory);
const github = new GitHubService(library, new GitHubClient(githubFixture(await fs.readFile(fixture)).fetcher, async () => "fixture-token"));
const server = createServer({ enableInteract: true, library, github });
const client = new Client({ name: "github-browser-test", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
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
  await view.getByText("从 GitHub 找资料", { exact: true }).click();
  await expect(view.locator("#github-account")).toContainText("learner");
  await view.locator("#github-starred").click();
  await expect(view.locator("#github-repositories")).toContainText("learner/course");
  await view.locator("#github-repositories button").click();
  await expect(view.locator("#github-location")).toContainText(commitA.slice(0, 12));
  await view.locator("#github-files").getByRole("button", { name: "README.md", exact: true }).click();
  await expect(view.locator("#text-reader-content h1")).toHaveText("Learning notes");
  await expect(view.locator("#text-reader-content script, #text-reader-content img, #text-reader-content iframe")).toHaveCount(0);
  assert.equal(await page.frames().find(f => f.url().endsWith("/app"))!.evaluate(() => (window as any).githubInjected), undefined);
  await page.screenshot({ path: path.join(artifacts, "github-markdown.png") });
  const select = async (selector: string) => page.frames().find(f => f.url().endsWith("/app"))!.evaluate((sel) => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector(sel)!);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange"));
  }, selector);
  await select("#text-reader-content strong");
  await view.locator("#text-reader-explain").click();
  await expect.poll(() => page.evaluate(() => (window as any).observations.messages.length)).toBe(1);
  const message = await page.evaluate(() => (window as any).observations.messages[0].content[0].text);
  assert.ok(message.includes("useful idea")); assert.ok(message.includes(commitA)); assert.ok(message.includes('"lineStart":3'));
  await view.locator("#text-reader-toggle").click();
  await expect(view.locator(".source-line")).toHaveCount(14);
  await view.locator("#library-home").click();
  await view.locator("#github-files").getByRole("button", { name: "目录 · src", exact: true }).click();
  await view.locator("#github-files").getByRole("button", { name: "example.ts", exact: true }).click();
  await expect(view.locator("#text-reader-content")).toContainText("return a + b");
  await expect(view.locator("#text-reader-content .hljs-keyword").first()).toBeVisible();
  await select('#text-reader-content [data-line-start="3"] code');
  await page.evaluate(() => { (window as any).observations.rejectNextMessage = true; });
  await view.locator("#text-reader-explain").click();
  await expect(view.locator("#text-reader-status")).toContainText("未接受");
  await view.locator("#text-reader-explain").click();
  await expect(view.locator("#text-reader-status")).toContainText("已发送");
  const codeMessage = await page.evaluate(() => (window as any).observations.messages.at(-1).content[0].text);
  assert.ok(codeMessage.includes('"path":"src/example.ts"')); assert.ok(codeMessage.includes('"lineStart":3')); assert.ok(codeMessage.includes('"lineEnd":3'));
  await page.frames().find(f => f.url().endsWith("/app"))!.evaluate(() => {
    const first = document.querySelector('#text-reader-content [data-line-start="2"] code')!;
    const last = document.querySelector('#text-reader-content [data-line-start="3"] code')!;
    const range = document.createRange(); range.setStart(first, 0); range.setEnd(last, last.childNodes.length);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange"));
  });
  await view.locator("#text-reader-explain").click();
  const multiline = await page.evaluate(() => (window as any).observations.messages.at(-1).content[0].text);
  const multilineContext = JSON.parse(multiline.slice(multiline.indexOf('{"schemaVersion"')));
  assert.equal(multilineContext.selection.text, "export function add(a: number, b: number) {\n  return a + b;");
  await view.locator("#text-reader-line").fill("3"); await view.locator("#text-reader-go").click();
  await expect(view.locator("#text-reader-status")).toContainText("已保存");
  await page.screenshot({ path: path.join(artifacts, "github-code.png") });
  await view.locator("#library-home").click();
  await view.locator("#github-parent").click();
  await view.locator("#github-files").getByRole("button", { name: "paper.pdf", exact: true }).click();
  await expect(view.locator("#text-layer")).toContainText("Alpha unique");
  await select("#text-layer span"); await view.locator("#explain-selection-btn").click();
  const pdfMessage = await page.evaluate(() => (window as any).observations.messages.at(-1).content[0].text);
  assert.ok(pdfMessage.includes(commitA)); assert.ok(pdfMessage.includes('"path":"paper.pdf"'));
  await view.locator("#library-home").click();
  await expect(view.locator("#library-list .library-item")).toHaveCount(3);
  const codeAsset = library.list().find(a => a.githubSource?.path === "src/example.ts")!;
  assert.equal(library.state(codeAsset.assetId).page, 3);
  await view.locator('[data-asset-id="' + codeAsset.assetId + '"] button').click();
  await expect(view.locator("#text-reader-line")).toHaveValue("3");
  assert.deepEqual(errors, []);
  assert.ok(await page.frames().find(f => f.url().endsWith("/app"))!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  console.log("PASS GitHub account, stars, commit-pinned tree, Markdown sanitization, source mode, code highlighting, selected-line questions, rejected send, PDF provenance and persisted position at 380px.");
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, "github-failure.png") }).catch(() => {}); throw error;
} finally {
  await browser.close(); http.stop(true);
  for (const id of viewIds) stopFileWatch(id);
  await client.close(); await server.close(); library.close(); Bun.gc(true);
  assert.ok(directory.startsWith(path.join(artifacts, "library-test-")));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
