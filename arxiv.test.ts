import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ArxivClient, ArxivService, arxivId, parseArxivFeed } from "./arxiv.js";
import { createLibrary } from "./server.js";
import { ACTIVE_IMPORT_STATES, type ArxivJob } from "./src/arxiv-types.js";
import { atomFeed } from "./tests/helpers/arxiv-fixture.js";

const fixture = path.resolve("tests/fixtures/reader-smoke.pdf");
const bytes = await fs.readFile(fixture);
const fakeFetch = (fn: (url: URL, init?: RequestInit) => Promise<Response> | Response) =>
  ((input: string | URL | Request, init?: RequestInit) => fn(new URL(String(input)), init)) as typeof fetch;
async function settled(service: ArxivService, job: ArxivJob) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = service.get(job.jobId);
    if (!ACTIVE_IMPORT_STATES.includes(current.state)) return current;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error("Download did not settle");
}
async function clean(directory: string) {
  expect(directory.startsWith(path.join(os.tmpdir(), "arxiv-test-"))).toBe(true);
  Bun.gc(true); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

describe("arXiv boundary", () => {
  it("normalizes official identifiers and rejects foreign URLs or missing metadata versions", () => {
    expect(arxivId("https://arxiv.org/pdf/hep-th/9901001v2.pdf")).toEqual({ baseId: "hep-th/9901001", version: 2, id: "hep-th/9901001v2" });
    for (const value of ["https://arxiv.org.evil.test/abs/1706.03762v1", "https://arxiv.org@evil.test/pdf/1706.03762v1", "1706.03762v0", "../../book"]) expect(() => arxivId(value)).toThrow();
    const paper = parseArxivFeed(atomFeed(["1706.03762v1"])).papers[0];
    expect(paper.title).toBe("Test & paper"); expect(paper.authors).toHaveLength(2);
    expect(paper.pdfUrl).toBe("https://arxiv.org/pdf/1706.03762v1");
    expect(() => parseArxivFeed(atomFeed(["1706.03762"]))).toThrow();
    expect(() => parseArxivFeed('<!DOCTYPE feed [<!ENTITY x "abc">]><feed/>')).toThrow();
    expect(() => parseArxivFeed("<html>login</html>")).toThrow();
  });
  it("pins the resolved revision, propagates API errors and serializes requests", async () => {
    const times: number[] = [];
    const client = new ArxivClient(fakeFetch(async () => { times.push(Date.now()); await new Promise(r => setTimeout(r, 20)); return new Response(atomFeed(["1706.03762v3"])); }), 30);
    await Promise.all([client.resolve("1706.03762"), client.search("attention")]);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(28);
    await expect(client.resolve("1706.03762v1")).rejects.toThrow("指定");
    const denied = new ArxivClient(fakeFetch(() => new Response("rate limited", { status: 429 })), 0);
    await expect(denied.search("attention")).rejects.toThrow("受限");
  });
  it("rejects redirects to a different version or untrusted host before downloading it", async () => {
    for (const destination of ["https://evil.test/book.pdf", "https://arxiv.org/pdf/1706.03762v2"]) {
      let requests = 0;
      const client = new ArxivClient(fakeFetch(() => { requests++; return new Response(null, { status: 302, headers: { location: destination } }); }), 0);
      await expect(client.download(parseArxivFeed(atomFeed(["1706.03762v1"])).papers[0], "unused.pdf", new AbortController().signal, () => {})).rejects.toThrow();
      expect(requests).toBe(1);
    }
  });
});

describe("arXiv jobs and library", () => {
  it("returns a job immediately, deduplicates, groups paper revisions, and retains provenance across restart", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arxiv-test-"));
    let library = createLibrary(directory);
    const requested: string[] = [];
    const client = new ArxivClient(fakeFetch(url => {
      requested.push(url.href);
      if (url.pathname === "/api/query") return new Response(atomFeed([url.searchParams.get("id_list")!]));
      return new Response(bytes, { headers: { "content-type": "application/pdf", "content-length": String(bytes.length) } });
    }), 0);
    let service = new ArxivService(library, client);
    try {
      expect(() => service.start("1706.03762")).toThrow("确定版本");
      const job = service.start("1706.03762v1"); expect(job.state).toBe("queued");
      expect(service.start("1706.03762v1").jobId).toBe(job.jobId);
      const done = await settled(service, job); expect(done.state).toBe("completed");
      const first = library.asset(done.assetId!); expect(first.source?.id).toBe("1706.03762v1");
      library.setPage(first.assetId, 2); library.bookmark(first.assetId, "add", 2, "v1 bookmark");
      expect(service.start("1706.03762v1").assetId).toBe(first.assetId);
      const secondJob = await settled(service, service.start("1706.03762v2"));
      expect(secondJob.state).toBe("completed");
      const second = library.asset(secondJob.assetId!);
      expect(second.documentId).toBe(first.documentId); expect(second.versionId).not.toBe(first.versionId);
      expect(second.assetId).not.toBe(first.assetId); expect(second.sha256).toBe(first.sha256);
      expect(library.state(second.assetId).bookmarks).toEqual([]);
      expect(await fs.readdir(path.join(directory, "blobs"))).toHaveLength(1);
      const changed = path.join(directory, "tmp", "changed.pdf");
      await fs.writeFile(changed, Buffer.concat([bytes, Buffer.from("\n% changed revision bytes\n")]));
      await expect(library.importArxiv(changed, first.source!, new AbortController().signal)).rejects.toThrow("不同文件");
      expect(await fs.readFile(library.filePath(first.assetId))).toEqual(bytes);
      await service.close(); library.close(); Bun.gc(true);
      library = createLibrary(directory); service = new ArxivService(library, client);
      expect(library.state(first.assetId).page).toBe(2); expect(library.asset(second.assetId).source?.version).toBe(2);
      expect(service.get(done.jobId).assetId).toBe(first.assetId);
      expect(requested.filter(u => u.includes("/pdf/"))).toEqual(["https://arxiv.org/pdf/1706.03762v1", "https://arxiv.org/pdf/1706.03762v2"]);
    } finally { await service.close(); library.close(); await clean(directory); }
  });
  it("fails bad/incomplete PDFs, supports cancellation and retry, and recovers interrupted records", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arxiv-test-"));
    const library = createLibrary(directory);
    let mode = "html";
    const client = new ArxivClient(fakeFetch(async (url, init) => {
      if (url.pathname === "/api/query") return new Response(atomFeed([url.searchParams.get("id_list")!]));
      if (mode === "slow") {
        await new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); });
      }
      if (mode === "html") return new Response("<html>not pdf</html>", { headers: { "content-type": "application/pdf" } });
      return new Response(bytes, { headers: { "content-type": "application/pdf", "content-length": String(bytes.length + (mode === "short" ? 1 : 0)) } });
    }), 0);
    let service = new ArxivService(library, client);
    try {
      for (const failure of ["html", "short"]) {
        mode = failure; const job = await settled(service, service.start("1706.03762v1"));
        expect(job.state).toBe("failed"); expect(job.error).toBeTruthy(); expect(library.list()).toHaveLength(0);
      }
      mode = "slow"; const slow = service.start("1706.03762v1");
      while (service.get(slow.jobId).state !== "downloading") await new Promise(r => setTimeout(r, 5));
      service.cancel(slow.jobId); await service.close(); expect(service.get(slow.jobId).state).toBe("cancelled");
      mode = "good"; const good = await settled(service, service.start("1706.03762v1")); expect(good.state).toBe("completed");
      await service.close();
      library.saveJob({ jobId: randomUUID(), requestedId: "1706.03762v2", state: "downloading", receivedBytes: 99, totalBytes: 100, updatedAt: "2020" });
      service = new ArxivService(library, client);
      expect(service.list().find(j => j.requestedId.endsWith("v2"))?.state).toBe("interrupted");
      expect(await fs.readdir(path.join(directory, "tmp"))).toEqual([]);
    } finally { await service.close(); library.close(); await clean(directory); }
  });
  it("upgrades a populated v1 database without changing original identities, bookmarks or migration receipts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arxiv-test-"));
    await fs.mkdir(path.join(directory, "blobs"));
    const hash = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(path.join(directory, "blobs", hash), bytes);
    const db = new DatabaseSync(path.join(directory, "library.sqlite"));
    db.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT NOT NULL);
      CREATE TABLE versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id));
      CREATE TABLE assets(id TEXT PRIMARY KEY,version_id TEXT NOT NULL REFERENCES versions(id),sha256 TEXT NOT NULL UNIQUE,file_name TEXT NOT NULL,byte_length INTEGER NOT NULL,page_count INTEGER NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE reading_positions(asset_id TEXT PRIMARY KEY REFERENCES assets(id),page INTEGER NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE bookmarks(asset_id TEXT NOT NULL REFERENCES assets(id),page INTEGER NOT NULL,title TEXT NOT NULL,PRIMARY KEY(asset_id,page));
      CREATE TABLE legacy_migrations(asset_id TEXT NOT NULL REFERENCES assets(id),client_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(asset_id,client_id,fingerprint));
      INSERT INTO documents VALUES('doc','Old local PDF'); INSERT INTO versions VALUES('version','doc');
      PRAGMA user_version=1;`);
    db.prepare("INSERT INTO assets VALUES('asset','version',?,'old.pdf',?,3,'fp','2020')").run(hash, bytes.length);
    db.exec("INSERT INTO reading_positions VALUES('asset',2,'2020'); INSERT INTO bookmarks VALUES('asset',2,'old bookmark'); INSERT INTO legacy_migrations VALUES('asset','client','fp');");
    db.close(); Bun.gc(true);
    const library = createLibrary(directory);
    try {
      expect((await library.verify("asset")).versionId).toBe("version");
      expect(library.state("asset")).toEqual({ page: 2, bookmarks: [{ page: 2, title: "old bookmark" }] });
      library.bookmark("asset", "remove", 2);
      expect(library.migrate("asset", "client", "fp", { page: 1, bookmarks: [{ page: 2, title: "old bookmark" }] }).bookmarks).toEqual([]);
    } finally { library.close(); await clean(directory); }
  });
  it("rolls back schema migration when existing foreign keys are broken", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arxiv-test-"));
    const file = path.join(directory, "library.sqlite");
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA foreign_keys=OFF;
      CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT NOT NULL);
      CREATE TABLE versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id));
      CREATE TABLE assets(id TEXT PRIMARY KEY,version_id TEXT NOT NULL REFERENCES versions(id),sha256 TEXT NOT NULL UNIQUE,file_name TEXT NOT NULL,byte_length INTEGER NOT NULL,page_count INTEGER NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL);
      INSERT INTO assets VALUES('preserved','missing','hash','old.pdf',100,1,'fp','2020'); PRAGMA user_version=1;`);
    db.close(); Bun.gc(true);
    expect(() => createLibrary(directory)).toThrow("回滚"); Bun.gc(true);
    const reopened = new DatabaseSync(file);
    try {
      expect(reopened.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
      expect(reopened.prepare("SELECT id FROM assets").get()).toMatchObject({ id: "preserved" });
      expect(reopened.prepare("SELECT name FROM sqlite_master WHERE name='arxiv_sources'").get()).toBeUndefined();
    } finally { reopened.close(); await clean(directory); }
  });
});
