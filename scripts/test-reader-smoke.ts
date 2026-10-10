/**
 * Real-browser smoke test with the actual SDK AppBridge and MCP server.
 * Run after npm run build: npx bun scripts/test-reader-smoke.ts
 * It verifies host requests, not ChatGPT account integration or model answers.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { chromium, expect } from "@playwright/test";
import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { allowedLocalFiles, createServer, pathToFileUrl, RESOURCE_URI, stopFileWatch } from "../server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "tests/.artifacts");
await fs.mkdir(artifacts, { recursive: true });
const fixture = path.join(root, "tests/fixtures/reader-smoke.pdf");
allowedLocalFiles.add(fixture);
const noOutlineFixture = path.join(artifacts, "reader-no-outline.pdf");
const withoutOutline = await PDFDocument.load(await fs.readFile(fixture));
withoutOutline.catalog.delete(PDFName.of("Outlines"));
await fs.writeFile(noOutlineFixture, await withoutOutline.save());
allowedLocalFiles.add(noOutlineFixture);
const server = createServer({ enableInteract: true });
const client = new Client({ name: "reader-smoke", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
let initial: Awaited<ReturnType<typeof client.callTool>>;
const viewIds = new Set<string>();
const hostBuild = await Bun.build({ entrypoints: [path.join(root, "tests/host.ts")], target: "browser", minify: false });
assert.ok(hostBuild.success, hostBuild.logs.join("\n"));
const hostScript = await hostBuild.outputs[0].text();
const appResource = (await client.readResource({ uri: RESOURCE_URI })).contents[0];
assert.ok("text" in appResource, "The MCP UI resource must contain HTML");
const appHtml = appResource.text;
type AppCsp = {
  resourceDomains?: string[];
  connectDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};
const declaredCsp = (appResource._meta?.ui as { csp?: AppCsp } | undefined)?.csp ?? {};

function appContentSecurityPolicy(csp: AppCsp): string {
  // Match the desktop host's metadata mapping: no default CDN allowlist;
  // resourceDomains also permit fetches, while worker creation uses blob:.
  // The worker's dynamic import still has to satisfy script-src.
  const resources = (csp.resourceDomains ?? []).join(" ");
  const connections = [...new Set([...(csp.connectDomains ?? []), ...(csp.resourceDomains ?? [])])].join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${resources}`,
    `style-src 'unsafe-inline' ${resources}`,
    `img-src data: blob: ${resources}`,
    `font-src data: blob: ${resources}`,
    `media-src data: blob: ${resources}`,
    "worker-src blob:",
    `connect-src ${connections || "'none'"}`,
    `frame-src ${(csp.frameDomains ?? []).join(" ") || "'none'"}`,
    `base-uri ${(csp.baseUriDomains ?? []).join(" ") || "'self'"}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}
let reproduceMissingWorkerSchemes = false;
const http = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const route = new URL(request.url).pathname;
    if (route === "/") return new Response('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe title="PDF reader"></iframe><script type="module" src="/host.js"></script>', { headers: { "content-type": "text/html" } });
    if (route === "/host.js") return new Response(hostScript, { headers: { "content-type": "application/javascript" } });
    if (route === "/app") {
      const csp = reproduceMissingWorkerSchemes ? {
        ...declaredCsp,
        resourceDomains: (declaredCsp.resourceDomains ?? []).filter((origin) => origin !== "data:" && origin !== "blob:"),
      } : declaredCsp;
      return new Response(appHtml, { headers: {
        "content-type": "text/html",
        "content-security-policy": appContentSecurityPolicy(csp),
      } });
    }
    if (route === "/initial") {
      const source = new URL(request.url).searchParams.has("no-outline") ? noOutlineFixture : fixture;
      initial = await client.callTool({ name: "display_pdf", arguments: { url: pathToFileUrl(source) } });
      assert.ok(!initial.isError, JSON.stringify(initial));
      viewIds.add(String(initial._meta?.viewUUID));
      return Response.json(initial);
    }
    if (route === "/tool" && request.method === "POST") {
      return Response.json(await client.callTool(await request.json()));
    }
    return new Response("Not found", { status: 404 });
  },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
const browserErrors: string[] = [];
page.on("pageerror", (error) => browserErrors.push(error.message));
page.setDefaultTimeout(15_000);
const checks: string[] = [];
const check = (description: string) => { checks.push(description); console.log(`PASS ${description}`); };

async function observations() {
  return page.evaluate(() => (window as any).observations);
}
function textOf(value: any): string {
  return (value?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}
async function selectText(text: string) {
  const frame = page.frames().find((entry) => entry.url().endsWith("/app"))!;
  const span = frame.locator("#text-layer span").filter({ hasText: new RegExp(`^${text}$`) });
  await expect(span).toBeVisible();
  const bounds = await span.boundingBox();
  assert.ok(bounds, `Missing rendered text bounds for ${text}`);
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 1, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => frame.evaluate(() => window.getSelection()?.toString())).toBe(text);
}

try {
  // Prove the original CSP failure separately, without letting its expected
  // console error contaminate the positive workflow's browser-error assertion.
  const cspProbe = await browser.newPage();
  const cspErrors: string[] = [];
  const compactWorkerError = (text: string) => text
    .replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, "data:text/javascript;base64,<bundled-worker>")
    .slice(0, 2500);
  cspProbe.on("console", (message) => {
    if (message.type() === "error") cspErrors.push(compactWorkerError(message.text()));
  });
  try {
    reproduceMissingWorkerSchemes = true;
    await cspProbe.goto(`http://127.0.0.1:${http.port}`);
    const failedReader = cspProbe.frameLocator("iframe");
    await expect(failedReader.locator("#error")).toBeVisible();
    await expect(failedReader.locator("#error-message")).toContainText(/worker|module|import/i);
    assert.ok(cspErrors.some((message) => /Content Security Policy|script-src/i.test(message) && /data:/i.test(message)),
      `Expected the data: worker import to be blocked by CSP: ${cspErrors.join("\n")}`);
    await fs.writeFile(path.join(artifacts, "reader-worker-csp-regression.json"), JSON.stringify({
      error: compactWorkerError(await failedReader.locator("#error-message").innerText()),
      consoleErrors: cspErrors,
    }, null, 2));
    check("original resource policy blocks the inlined worker import and shows a load error");
  } finally {
    await cspProbe.close();
    reproduceMissingWorkerSchemes = false;
  }

  await page.goto(`http://127.0.0.1:${http.port}`);
  let view = page.frameLocator("iframe");
  await expect(view.locator("#total-pages")).toContainText("3");
  await expect(view.locator("#text-layer")).toContainText("Alpha unique first-page context.");
  check("real MCP PDF loading and selectable text under the resource's declared CSP");

  await expect(view.locator("#reader-navigation")).toContainText("第一章 起步");
  await view.locator('#reader-navigation .reader-outline-jump[data-page="2"]').click();
  await expect(view.locator("#page-input")).toHaveValue("2");
  await expect(view.locator("#text-layer")).toContainText("Beta unique second-page context.");
  check("nested PDF outline destination navigation");

  await selectText("章");
  await expect(view.locator("#explain-selection-btn")).toBeEnabled();
  await expect.poll(async () => textOf((await observations()).contexts.at(-1))).toContain("<pdf-selection>章</pdf-selection>");
  await view.locator("#explain-selection-btn").click();
  await expect.poll(async () => (await observations()).messages.length).toBe(1);
  const singleCharacterMessage = textOf((await observations()).messages[0]);
  assert.ok(singleCharacterMessage.includes("章"), singleCharacterMessage);
  assert.match(singleCharacterMessage, /2/);
  check("single Chinese character reaches host context and explicit question");

  const expanded = await client.callTool({ name: "interact", arguments: {
    viewUUID: initial.structuredContent?.viewUUID, action: "display_mode", mode: "fullscreen",
  } });
  assert.ok(!expanded.isError, JSON.stringify(expanded));
  assert.equal(JSON.parse(textOf(expanded)).displayMode, "fullscreen");
  await expect(view.getByRole("button", { name: "收起阅读器", exact: true })).toBeVisible();
  await expect(view.locator("#page-input")).toHaveValue("2");
  await expect(view.locator("#reader-navigation")).toContainText("第一章 起步");
  await selectText("章");
  const selectedChapter = await view.locator("#text-layer span").filter({ hasText: /^章$/ }).boundingBox();
  assert.ok(selectedChapter);
  await page.mouse.click(selectedChapter.x + selectedChapter.width / 2, selectedChapter.y + selectedChapter.height / 2, { button: "right" });
  await view.getByRole("menuitem", { name: "向 GPT 提问", exact: true }).click();
  await expect(view.locator("#selection-context-menu")).toBeHidden();
  await expect.poll(async () => (await observations()).messages.length).toBe(2);
  assert.match(textOf((await observations()).messages[1]), /章/);
  check("expanded reader preserves page and outline; a real selected-text right-click sends one question to the host");

  await view.getByRole("button", { name: "收起阅读器", exact: true }).click();
  await expect(view.getByRole("button", { name: "展开阅读器", exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).observations.rejectNextDisplayMode = true; });
  const refusedMode = await client.callTool({ name: "interact", arguments: {
    viewUUID: initial.structuredContent?.viewUUID, action: "display_mode", mode: "fullscreen",
  } });
  assert.equal(refusedMode.isError, true, JSON.stringify(refusedMode));
  assert.match(textOf(refusedMode), /未切换/);
  await expect(view.getByRole("button", { name: "展开阅读器", exact: true })).toBeVisible();
  check("host refusal to expand is reported as a tool error instead of success");

  await view.locator("#next-btn").click();
  await expect(view.locator("#page-input")).toHaveValue("3");
  await expect(view.locator("#explain-selection-btn")).toBeDisabled();
  await expect.poll(async () => textOf((await observations()).contexts.at(-1))).not.toContain("<pdf-selection>");
  check("turning page clears selected-text question and model context");

  await view.locator('#reader-navigation .reader-outline-jump[data-page="1"]').click();
  await selectText("你好");
  await expect.poll(async () => textOf((await observations()).contexts.at(-1))).toContain("<pdf-selection>你好</pdf-selection>");
  await view.locator("#explain-selection-btn").click();
  await expect.poll(async () => (await observations()).messages.length).toBe(3);
  assert.ok(textOf((await observations()).messages[2]).includes("你好"));
  check("two-character Chinese selection remains available when button is clicked");

  await page.evaluate(() => { (window as any).observations.rejectNextMessage = true; });
  await view.locator("#explain-selection-btn").click();
  await expect(view.locator("#selection-status")).toContainText("发送失败");
  await expect(view.locator("#explain-selection-btn")).toBeEnabled();
  check("host-rejected message shows failure and allows retry");

  const pageBounds = await view.locator("#pdf-canvas").boundingBox();
  assert.ok(pageBounds);
  await page.mouse.click(pageBounds.x + pageBounds.width - 25, pageBounds.y + 100);
  await expect(view.locator("#explain-selection-btn")).toBeDisabled();
  await expect.poll(async () => textOf((await observations()).contexts.at(-1))).not.toContain("<pdf-selection>");
  check("clearing selection clears the question action and model selection markers");

  await view.locator("#search-btn").click();
  await view.locator("#search-input").fill("shared-reading-marker");
  await expect(view.locator("#search-match-count")).toHaveText("1 of 3");
  await view.locator("#search-next-btn").click();
  await expect(view.locator("#page-input")).toHaveValue("2");
  await view.locator("#search-close-btn").click();
  check("search finds matches across all pages and navigates");

  await view.getByRole("tab", { name: "书签", exact: true }).click();
  await view.getByRole("button", { name: "添加当前页书签" }).click();
  await expect(view.getByRole("button", { name: /^跳转至第 2 页/ })).toBeVisible();
  await page.reload();
  view = page.frameLocator("iframe");
  await expect(view.locator("#page-input")).toHaveValue("2");
  await expect(view.locator("#text-layer")).toContainText("Beta unique second-page context.");
  await view.getByRole("tab", { name: "书签", exact: true }).click();
  await expect(view.getByRole("button", { name: /^跳转至第 2 页/ })).toBeVisible();
  check("reading page and bookmark survive host reload");

  const result = await client.callTool({ name: "interact", arguments: {
    viewUUID: initial._meta?.viewUUID, action: "highlight_text", page: 2,
    query: "Beta unique", color: "#fff200", content: "Smoke test annotation",
  } });
  assert.ok(!result.isError, JSON.stringify(result));
  await expect(view.locator("#annotations-badge")).toContainText("1");
  await view.locator("#download-btn").click();
  await expect.poll(async () => (await observations()).downloads.length).toBe(1);
  const download = (await observations()).downloads[0];
  const resource = download.contents[0].resource;
  const bytes = new Uint8Array(Buffer.from(resource.blob, "base64"));
  await fs.writeFile(path.join(artifacts, "reader-smoke-export.pdf"), bytes);
  const exported = await getDocument({ data: bytes }).promise;
  assert.equal(exported.numPages, 3);
  const annotations = await (await exported.getPage(2)).getAnnotations();
  assert.ok(annotations.some((annotation: any) => annotation.subtype === "Highlight" && annotation.contentsObj?.str === "Smoke test annotation"), JSON.stringify(annotations));
  await exported.destroy();
  check("real annotation command exports a PDF with a readable Highlight object");

  await page.reload();
  view = page.frameLocator("iframe");
  await expect(view.locator("#page-input")).toHaveValue("2");
  await expect(view.locator("#annotations-badge")).toContainText("1");
  check("annotation persists when reopening the PDF in a new tool-call instance");

  await page.screenshot({ path: path.join(artifacts, "reader-smoke-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 620, height: 850 });
  await expect(view.locator("#explain-selection-btn")).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "reader-smoke-narrow.png"), fullPage: true });
  await page.setViewportSize({ width: 380, height: 850 });
  await expect(view.locator("#outline-toggle")).toBeVisible();
  await view.locator("#outline-toggle").click();
  await expect(view.locator('#reader-navigation .reader-outline-jump[data-page="3"]')).toBeVisible();
  await view.locator('#reader-navigation .reader-outline-jump[data-page="3"]').click();
  await expect(view.locator("#page-input")).toHaveValue("3");
  await expect(view.getByRole("button", { name: "展开阅读器", exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "reader-smoke-sidebar.png"), fullPage: true });
  check("380px sidebar keeps an accessible outline button and chapter navigation");
  await page.setViewportSize({ width: 1200, height: 950 });
  await page.goto(`http://127.0.0.1:${http.port}/?no-outline=1`);
  view = page.frameLocator("iframe");
  await expect(view.locator("#reader-navigation")).toContainText("此 PDF 未提供章节目录");
  await expect(view.locator("#total-pages")).toContainText("3");
  check("PDF without outline explains the fallback and remains readable");
  assert.deepEqual(browserErrors, [], `Browser errors: ${browserErrors.join("; ")}`);
  check("desktop/narrow viewport screenshots and no uncaught browser exceptions");
  console.log(`\n${checks.length} smoke checks passed. Host behavior is simulated; SDK, MCP server, PDF, browser rendering, and exported PDF are real.`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, "reader-smoke-failure.png"), fullPage: true });
  await fs.writeFile(path.join(artifacts, "reader-smoke-failure.json"), JSON.stringify({ error: String(error), browserErrors, observations: await observations() }, null, 2));
  throw error;
} finally {
  await browser.close();
  http.stop(true);
  for (const id of viewIds) stopFileWatch(id);
  await client.close();
  await server.close();
}
