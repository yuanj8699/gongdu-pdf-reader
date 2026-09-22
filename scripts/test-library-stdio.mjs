import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PDFDocument } from "@cantoo/pdf-lib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reader-library-"));
const source = path.join(temporary, "original.pdf");
const libraryDirectory = path.join(temporary, "library");
const bytes = await fs.readFile(path.join(root, "tests/fixtures/reader-smoke.pdf"));
await fs.writeFile(source, bytes);
let client;
let stderr = "";
async function start() {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, "dist/index.js"), "--stdio", source], cwd: root, stderr: "pipe",
    env: { ...process.env, PDF_READER_DATA_DIR: libraryDirectory } });
  transport.stderr?.on("data", data => { stderr += data; });
  client = new Client({ name: "library-restart-test", version: "1" });
  await client.connect(transport);
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent;
}
async function denied(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `Expected rejection: ${JSON.stringify(result)}`);
}

try {
  await start();
  assert.equal((await call("library_list")).entries.length, 0);
  await denied("library_import_pdf", { path: path.join(root, "tests/fixtures/reader-smoke.pdf") });
  const asset = await call("library_import_pdf", { path: source });
  assert.equal(asset.pageCount, 3);
  assert.equal(new Set([asset.documentId, asset.versionId, asset.assetId]).size, 3);
  assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await call("library_import_pdf", { path: source }), asset);

  const { uploadId } = await call("library_begin_upload", { fileName: "renamed.pdf", size: bytes.length });
  await denied("library_upload_chunk", { uploadId, offset: 3, bytes: bytes.subarray(0, 8).toString("base64") });
  await denied("library_finish_upload", { uploadId });
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    await call("library_upload_chunk", { uploadId, offset, bytes: bytes.subarray(offset, offset + 4096).toString("base64") });
  }
  assert.deepEqual(await call("library_finish_upload", { uploadId }), asset);
  assert.equal((await call("library_list")).entries.length, 1);
  console.log("PASS authorized path import, chunked file-picker import, exact-byte deduplication and distinct stable IDs");

  const clientId = randomUUID();
  const migration = { assetId: asset.assetId, clientId, fingerprint: asset.fingerprint, page: 2, bookmarks: [{ page: 2, title: "旧书签" }] };
  await denied("library_migrate_state", { ...migration, fingerprint: "wrong" });
  await call("library_migrate_state", migration);
  await call("library_set_page", { assetId: asset.assetId, page: 3 });
  await call("library_bookmark", { assetId: asset.assetId, action: "remove", page: 2 });
  await call("library_bookmark", { assetId: asset.assetId, action: "add", page: 3, title: "持久书签" });
  await denied("library_set_page", { assetId: asset.assetId, page: 4 });
  await denied("library_bookmark", { assetId: asset.assetId, action: "add", page: 0 });
  await client.close();
  await fs.rename(source, path.join(temporary, "moved-original.pdf"));
  await start();
  assert.deepEqual((await call("library_list")).entries.map(e => e.assetId), [asset.assetId]);
  const state = await call("library_migrate_state", migration);
  assert.deepEqual(state, { page: 3, bookmarks: [{ page: 3, title: "持久书签" }] });
  const opened = await call("display_pdf", { assetId: asset.assetId });
  assert.equal(opened.initialPage, 3);
  assert.equal(opened.libraryAsset.versionId, asset.versionId);
  assert.equal(opened.url, `library://${asset.assetId}`);
  const openedByUri = await call("display_pdf", { url: opened.url });
  assert.equal(openedByUri.initialPage, 3);
  assert.equal(openedByUri.libraryAsset.assetId, asset.assetId);
  const chunk = await call("read_pdf_bytes", { url: opened.url, offset: 0, byteCount: bytes.length });
  assert.deepEqual(Buffer.from(chunk.bytes, "base64"), bytes);
  await denied("save_pdf", { url: opened.url, data: bytes.toString("base64") });
  console.log("PASS actual Node process restart, moved source, immutable stored bytes, saved page/bookmarks, migration without resurrection");

  const html = Buffer.from("<html>This is a login page, not a PDF</html>");
  const large = await call("library_begin_upload", { fileName: "chunk-test.pdf", size: 256 * 1024 });
  assert.equal((await call("library_upload_chunk", { ...large, offset: 0, bytes: Buffer.alloc(256 * 1024, 65).toString("base64") })).receivedBytes, 256 * 1024);
  await call("library_cancel_upload", large);
  const invalid = await call("library_begin_upload", { fileName: "fake.pdf", size: html.length });
  await call("library_upload_chunk", { ...invalid, offset: 0, bytes: html.toString("base64") });
  await denied("library_finish_upload", invalid);
  const cancelled = await call("library_begin_upload", { fileName: "cancel.pdf", size: 9 });
  await call("library_cancel_upload", cancelled);
  await denied("library_finish_upload", cancelled);
  assert.equal((await call("library_list")).entries.length, 1);
  assert.equal((await fs.readdir(path.join(libraryDirectory, "tmp"))).length, 0);
  console.log("PASS invalid PDF, incomplete import, cancellation, page bounds and immutable-original rejection");

  const edited = await PDFDocument.load(bytes, { updateMetadata: false });
  edited.setTitle("Changed content retaining the original PDF trailer ID");
  const changedBytes = Buffer.from(await edited.save());
  const different = await call("library_begin_upload", { fileName: "changed.pdf", size: changedBytes.length });
  await call("library_upload_chunk", { ...different, offset: 0, bytes: changedBytes.toString("base64") });
  const changedAsset = await call("library_finish_upload", different);
  assert.notEqual(changedAsset.assetId, asset.assetId);
  assert.notEqual(changedAsset.versionId, asset.versionId);
  assert.equal(changedAsset.fingerprint, asset.fingerprint);
  await denied("library_migrate_state", { ...migration, assetId: changedAsset.assetId });
  assert.deepEqual(await call("library_get_state", { assetId: changedAsset.assetId }), { page: null, bookmarks: [] });
  console.log("PASS changed bytes create a new version; ambiguous legacy fingerprint cannot attach old bookmarks");
} catch (error) { console.error(stderr); throw error; }
finally {
  await client?.close();
  assert.ok(temporary.startsWith(path.join(os.tmpdir(), "reader-library-")));
  await fs.rm(temporary, { recursive: true, force: true });
}
