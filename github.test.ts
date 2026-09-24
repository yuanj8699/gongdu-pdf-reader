import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { GitHubClient, GitHubService, repositoryName } from "./github.js";
import { createLibrary, createServer } from "./server.js";
import { githubFixture, commitA, commitB, markdown } from "./tests/helpers/github-fixture.js";

const pdf = await fs.readFile("tests/fixtures/reader-smoke.pdf");
const guest = async () => undefined;
describe("GitHub read boundary", () => {
  it("accepts only repository homepages and keeps branches separate", () => {
    expect(repositoryName("https://github.com/learner/course.git")).toBe("learner/course");
    for (const s of ["https://github.com.evil.test/a/b", "https://x@github.com/a/b", "a/..", "a/b/blob/main/file.md", "https://github.com/a/b?token=secret"]) expect(() => repositoryName(s)).toThrow();
  });
  it("searches public repositories, resolves refs and browses pinned nested directories", async () => {
    const f = githubFixture(pdf), client = new GitHubClient(f.fetcher, guest);
    expect((await client.account()).connected).toBe(false);
    expect((await client.repositories("search", "learning")).repositories[0].fullName).toBe("learner/course");
    expect(await client.resolve("learner/course", "feature/reading")).toEqual({ repository: "learner/course", commit: commitA });
    expect((await client.directory("learner/course", commitA, "src")).entries[0].path).toBe("src/example.ts");
    const file = await client.file("learner/course", commitA, "src/example.ts");
    expect(file.source.url).toContain(commitA); expect(file.bytes.toString()).toContain("return a + b");
    expect(f.requests.every(r => r.authorization === null)).toBe(true);
    expect(f.requests.some(r => r.url.includes("feature%2Freading"))).toBe(true);
    await expect(client.directory("learner/course", commitA, "../src")).rejects.toThrow("路径");
    await expect(client.file("learner/course", commitA, "linked")).rejects.toThrow("符号链接");
  });
  it("uses local credentials for account lists, never follows redirects or exposes tokens", async () => {
    const f = githubFixture(pdf), client = new GitHubClient(f.fetcher, async () => "test-private-token");
    expect(await client.account()).toEqual({ connected: true, login: "learner" });
    expect((await client.repositories("starred")).repositories).toHaveLength(1);
    expect((await client.repositories("mine")).repositories).toHaveLength(1);
    expect(f.requests.every(r => r.authorization === "Bearer test-private-token")).toBe(true);
    await expect(new GitHubClient(f.fetcher, guest).repositories("mine")).rejects.toThrow("gh auth login");
    let calls = 0;
    const redirect = new GitHubClient((async (_input: any, init: any) => { calls++; expect(init.redirect).toBe("manual"); return new Response(null, { status: 302, headers: { location: "https://evil.test" } }); }) as typeof fetch, async () => "test-private-token");
    await expect(redirect.account()).rejects.toThrow("迁移"); expect(calls).toBe(1);
    for (const [status, message] of [[401, "失效"], [403, "权限"], [404, "未找到"], [429, "受限"]] as const) {
      const denied = new GitHubClient((async () => new Response("server may echo a secret", { status })) as typeof fetch, async () => "secret");
      await expect(denied.account()).rejects.toThrow(message);
    }
  });
  it("rejects corrupted blobs and oversized, truncated or binary data", async () => {
    const f = githubFixture(pdf);
    const corrupt = new GitHubClient((async (input: any, init: any) => String(input).includes("/blobs/") ? new Response("changed") : f.fetcher(input, init)) as typeof fetch, guest);
    await expect(corrupt.file("learner/course", commitA, "README.md")).rejects.toThrow("校验");
    const huge = new GitHubClient((async () => Response.json({ tree: [{ path: "big.md", sha: commitA, type: "blob", mode: "100644", size: 2 * 1024 * 1024 }] })) as typeof fetch, guest);
    await expect(huge.file("learner/course", commitA, "big.md")).rejects.toThrow("上限");
    const truncated = new GitHubClient((async () => Response.json({ tree: [], truncated: true })) as typeof fetch, guest);
    await expect(truncated.directory("learner/course", commitA)).rejects.toThrow("不完整");
    f.files.set("README.md", Buffer.from([0, 1, 2]));
    await expect(new GitHubClient(f.fetcher, guest).file("learner/course", commitA, "README.md")).rejects.toThrow("二进制");
  });
});

describe("GitHub library and MCP", () => {
  it("persists PDFs/text, deduplicates exact commits, isolates versions and reopens offline", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "github-test-"));
    let library = createLibrary(dir);
    let server: ReturnType<typeof createServer> | undefined, client: Client | undefined;
    try {
      const github = new GitHubService(library, new GitHubClient(githubFixture(pdf).fetcher, guest));
      const first = await github.importFile("learner/course", commitA, "README.md");
      expect(await library.readText(first.assetId)).toBe(markdown);
      library.setPage(first.assetId, 3);
      expect((await github.importFile("learner/course", commitA, "README.md")).assetId).toBe(first.assetId);
      const second = await github.importFile("learner/course", commitB, "README.md");
      expect(second.documentId).toBe(first.documentId); expect(second.assetId).not.toBe(first.assetId);
      expect(library.state(second.assetId).page).toBeNull();
      const paper = await github.importFile("learner/course", commitA, "paper.pdf");
      expect(paper.pageCount).toBe(3); expect(paper.githubSource?.format).toBe("pdf");
      server = createServer({ library, github }); client = new Client({ name: "github-test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(b), client.connect(a)]);
      const read = await client.callTool({ name: "library_read_text", arguments: { assetId: first.assetId } });
      expect(read.structuredContent?.text).toBe(markdown); expect(read._meta?.githubEnabled).toBe(true);
      expect((await client.callTool({ name: "display_pdf", arguments: { assetId: first.assetId } })).isError).toBe(true);
      await client.close(); client = undefined; await server.close(); server = undefined;
      library.close(); library = createLibrary(dir);
      expect(await library.readText(first.assetId)).toBe(markdown); expect(library.state(first.assetId).page).toBe(3);
      expect(library.list()).toHaveLength(3);
    } finally {
      await client?.close(); await server?.close(); library.close(); Bun.gc(true);
      expect(dir.startsWith(path.join(os.tmpdir(), "github-test-"))).toBe(true);
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  it("upgrades a v2 library while retaining existing PDF positions and bookmarks", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "github-test-"));
    let library = createLibrary(dir);
    try {
      const asset = await library.importLocal(path.resolve("tests/fixtures/reader-smoke.pdf"));
      library.setPage(asset.assetId, 2); library.bookmark(asset.assetId, "add", 3, "keep"); library.close();
      const db = new DatabaseSync(path.join(dir, "library.sqlite")); db.exec("DROP TABLE github_sources; PRAGMA user_version=2;"); db.close();
      library = createLibrary(dir);
      expect(library.state(asset.assetId)).toEqual({ page: 2, bookmarks: [{ page: 3, title: "keep" }] });
      expect((await library.verify(asset.assetId)).sha256).toBe(asset.sha256);
    } finally { library.close(); Bun.gc(true); expect(dir.startsWith(path.join(os.tmpdir(), "github-test-"))).toBe(true); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
});
