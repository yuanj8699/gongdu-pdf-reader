import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "tests/fixtures/reader-smoke.pdf");
const libraryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-stdio-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist/index.js"), "--stdio", fixture],
  cwd: root,
  stderr: "pipe",
  env: { ...process.env, PDF_READER_DATA_DIR: libraryDirectory },
});
let stderr = "";
transport.stderr?.on("data", data => { stderr += data; });
const client = new Client({ name: "stdio-reader-check", version: "1" });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const display = tools.find(tool => tool.name === "display_pdf");
  const launcher = tools.find(tool => tool.name === "open_library");
  assert.equal(display?.title, "PDF 阅读器");
  assert.match(display?._meta?.ui?.resourceUri, /^ui:\/\//);
  assert.ok(
    launcher?._meta?.["openai/ui"]?.entrypoints?.some(entrypoint => entrypoint.type === "thread"),
    "The reader must be available in the Codex side-panel launcher",
  );
  assert.ok(tools.some(tool => tool.name === "interact"));
  const listing = await client.callTool({ name: "list_pdfs", arguments: {} });
  assert.ok(!listing.isError, JSON.stringify(listing));
  assert.match(JSON.stringify(listing), /reader-smoke\.pdf/);
  const library = await client.callTool({ name: "open_library", arguments: {} });
  assert.equal(library.structuredContent?.kind, "library");
  // Direct display_pdf calls keep the configured default document.
  const result = await client.callTool({ name: "display_pdf", arguments: {} });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(result.structuredContent?.viewUUID);
  const openedUrl = result.structuredContent?.url;
  assert.equal(typeof openedUrl, "string");
  const openedPath = openedUrl.startsWith("file://")
    ? decodeURIComponent(openedUrl.slice(7))
    : openedUrl;
  assert.equal(path.resolve(openedPath), fixture, "The launcher must open the registered PDF");
  assert.equal(result.structuredContent?.initialPage, 1);
  assert.ok(result.structuredContent?.totalBytes > 0);
  const resource = await client.readResource({ uri: display._meta.ui.resourceUri });
  assert.match(resource.contents[0].mimeType, /mcp-app/);
  assert.ok(resource.contents[0].text.includes("explain-selection-btn"));
  const denied = await client.callTool({ name: "display_pdf", arguments: { url: path.join(root, "package.json") } });
  assert.equal(denied.isError, true, "Unregistered files must remain inaccessible");
  console.log("PASS: built Node stdio handshake, side-panel entrypoint, default registered PDF, interactive HTML, unregistered-file boundary");
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  await client.close();
  assert.ok(libraryDirectory.startsWith(path.join(os.tmpdir(), "reader-stdio-")));
  await fs.rm(libraryDirectory, { recursive: true, force: true });
}
