import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "reader-local-"));
const source = path.join(temp, "source"), outside = path.join(temp, "outside");
const bytes = await fs.readFile(path.join(project, "tests/fixtures/reader-smoke.pdf"));
await fs.mkdir(path.join(source, "nested"), { recursive: true });
await fs.mkdir(outside);
await fs.writeFile(path.join(source, "nested", "book.PDF"), bytes);
await fs.writeFile(path.join(source, "duplicate.pdf"), bytes);
await fs.writeFile(path.join(source, "broken.pdf"), "not a PDF");
await fs.writeFile(path.join(source, "ignored.epub"), "epub");
await fs.writeFile(path.join(outside, "outside.pdf"), bytes);
await fs.symlink(outside, path.join(source, "linked"), process.platform === "win32" ? "junction" : "dir");
let client;
async function start() {
  client = new Client({ name: "local-folder-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.join(project, "dist/index.js"), "--stdio", `--library-dir=${source}`],
    cwd: project, stderr: "pipe", env: { ...process.env, PDF_READER_DATA_DIR: path.join(temp, "data") } }));
}
async function call(name, args = {}, error = false) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(Boolean(result.isError), error, JSON.stringify(result));
  return result.structuredContent;
}
try {
  await start();
  assert.deepEqual((await call("library_directories")).roots, [source]);
  const scan = await call("library_scan_directory", { root: source });
  assert.equal(scan.files.length, 3);
  assert.equal(scan.skipped.length, 1);
  assert.equal(scan.truncated, false);
  await call("library_scan_directory", { root: outside }, true);
  for (const relativePath of ["../outside/outside.pdf", path.join(outside, "outside.pdf"), "linked/outside.pdf", "ignored.epub"]) {
    await call("library_import_directory_pdf", { root: source, relativePath }, true);
  }
  await call("display_pdf", { url: path.join(source, "duplicate.pdf") }, true);
  await call("save_pdf", { url: path.join(source, "duplicate.pdf"), data: bytes.toString("base64") }, true);
  console.log("PASS recursive PDF scan, link skipping, path boundaries and source write denial");
  const asset = await call("library_import_directory_pdf", { root: source, relativePath: "nested/book.PDF" });
  await call("library_set_page", { assetId: asset.assetId, page: 2 });
  await call("library_bookmark", { assetId: asset.assetId, action: "add", page: 2, title: "keep" });
  await call("library_import_directory_pdf", { root: source, relativePath: "broken.pdf" }, true);
  const duplicate = await call("library_import_directory_pdf", { root: source, relativePath: "duplicate.pdf" });
  assert.equal(duplicate.assetId, asset.assetId);
  assert.equal((await call("library_list")).entries.length, 1);
  assert.deepEqual(await fs.readFile(path.join(source, "duplicate.pdf")), bytes);
  await fs.writeFile(path.join(source, "added.pdf"), bytes);
  assert.equal((await call("library_scan_directory", { root: source })).files.length, 4);
  await client.close(); await start();
  assert.equal((await call("display_pdf", { assetId: asset.assetId })).initialPage, 2);
  assert.equal((await call("library_get_state", { assetId: asset.assetId })).bookmarks[0].title, "keep");
  console.log("PASS invalid PDF isolation, content deduplication, rescan and persisted reading state");
} finally {
  await client?.close();
  assert.equal(path.dirname(temp), os.tmpdir());
  assert.ok(path.basename(temp).startsWith("reader-local-"));
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
