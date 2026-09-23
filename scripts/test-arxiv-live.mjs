// Explicit opt-in integration check against real arXiv. Uses an isolated temporary library.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arxiv-live-"));
let client;
let stderr = "";
async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist/index.js"), "--stdio"],
    cwd: root, stderr: "pipe", env: { ...process.env, PDF_READER_DATA_DIR: directory } });
  transport.stderr?.on("data", data => { stderr += data; });
  client = new Client({ name: "arxiv-live-check", version: "1" }); await client.connect(transport);
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent;
}
try {
  await connect();
  const found = await call("arxiv_search", { query: 'ti:"Attention Is All You Need"' });
  assert.ok(found.papers.some(p => p.baseId === "1706.03762"));
  console.log("PASS real arXiv keyword search");
  const { paper } = await call("arxiv_resolve", { id: "1706.03762v1" });
  assert.equal(paper.version, 1); assert.equal(paper.title, "Attention Is All You Need");
  const job = await call("arxiv_download", { id: paper.id });
  assert.ok(job.jobId);
  const deadline = Date.now() + 180000;
  let state = job;
  while (["queued", "resolving", "downloading", "validating"].includes(state.state) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000)); state = await call("arxiv_jobs", { jobId: job.jobId });
  }
  assert.equal(state.state, "completed", JSON.stringify(state));
  const entry = (await call("library_list")).entries[0];
  assert.equal(entry.source.id, paper.id); assert.ok(entry.pageCount > 1);
  const opened = await call("display_pdf", { assetId: entry.assetId });
  assert.equal(opened.libraryAsset.source.pdfUrl, "https://arxiv.org/pdf/1706.03762v1");
  const firstBytes = await call("read_pdf_bytes", { url: opened.url, offset: 0, byteCount: 8 });
  assert.ok(Buffer.from(firstBytes.bytes, "base64").toString().startsWith("%PDF-"));
  await call("library_set_page", { assetId: entry.assetId, page: 2 });
  await client.close(); await connect();
  assert.equal((await call("arxiv_jobs", { jobId: job.jobId })).assetId, entry.assetId);
  assert.equal((await call("display_pdf", { assetId: entry.assetId })).initialPage, 2);
  console.log(`PASS real versioned PDF download/validation, source provenance and Node restart: ${entry.source.id}, ${entry.pageCount} pages, ${entry.byteLength} bytes`);
} catch (error) { console.error(stderr); throw error; }
finally {
  await client?.close();
  assert.ok(directory.startsWith(path.join(os.tmpdir(), "arxiv-live-")));
  await fs.rm(directory, { recursive: true, force: true });
}
