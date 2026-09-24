import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Bookmark, LibraryAsset, LibraryEntry, ReadingState } from "./src/library-types.js";
import type { ArxivPaper, ArxivJob } from "./src/arxiv-types.js";
import type { GitHubSource } from "./src/github-types.js";

export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
type InspectPdf = (filePath: string) => Promise<{ pageCount: number; fingerprint: string }>;
type Upload = { path: string; name: string; size: number; offset: number; busy: boolean };

const assetQuery = `SELECT d.id AS documentId, v.id AS versionId, a.id AS assetId,
  d.title, a.file_name AS fileName, a.sha256, a.byte_length AS byteLength,
  a.page_count AS pageCount, a.fingerprint, a.created_at AS createdAt
  FROM assets a JOIN versions v ON v.id=a.version_id JOIN documents d ON d.id=v.document_id`;

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** Single-user local library. Originals are immutable, content-addressed files. */
export class LibraryService {
  private db: DatabaseSync;
  private uploads = new Map<string, Upload>();
  readonly directory: string;
  constructor(directory: string, private inspectPdf: InspectPdf) {
    this.directory = path.resolve(directory);
    for (const dir of ["blobs", "tmp", "exports"]) fs.mkdirSync(path.join(this.directory, dir), { recursive: true });
    this.db = new DatabaseSync(path.join(this.directory, "library.sqlite"));
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > 3) { this.db.close(); throw new Error("书库版本较新，请使用新版阅读器。"); }
    if (version === 0) {
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id));
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES versions(id), sha256 TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL, byte_length INTEGER NOT NULL, page_count INTEGER NOT NULL,
        fingerprint TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reading_positions (
        asset_id TEXT PRIMARY KEY REFERENCES assets(id), page INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bookmarks (
        asset_id TEXT NOT NULL REFERENCES assets(id), page INTEGER NOT NULL, title TEXT NOT NULL,
        PRIMARY KEY(asset_id,page));
      CREATE TABLE IF NOT EXISTS legacy_migrations (
        asset_id TEXT NOT NULL REFERENCES assets(id), client_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY(asset_id,client_id,fingerprint));
      PRAGMA user_version=1; COMMIT;`);
    }
    if (version < 2) {
      try { this.upgradeToV2(); }
      catch (error) { this.db.close(); throw error; }
    }
    if (version < 3) {
      try {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE github_sources (repository TEXT NOT NULL, file_path TEXT NOT NULL, commit_sha TEXT NOT NULL,
            asset_id TEXT NOT NULL UNIQUE REFERENCES assets(id), metadata TEXT NOT NULL,
            PRIMARY KEY(repository,file_path,commit_sha));
          PRAGMA user_version=3; COMMIT;`);
      } catch (error) { this.db.exec("ROLLBACK"); this.db.close(); throw error; }
    }
    // Remove only stale staging files created by this service, never live imports.
    for (const name of fs.readdirSync(path.join(this.directory, "tmp"))) {
      if (!/^[a-f0-9-]{36}\.part$/.test(name)) continue;
      const file = path.join(this.directory, "tmp", name);
      if (Date.now() - fs.statSync(file).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(file);
    }
  }

  private upgradeToV2() {
    // A blob can serve distinct paper versions; assets retain their own version identities.
    this.db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
    try {
      this.db.exec(`CREATE TABLE assets_v2 (
        id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES versions(id), sha256 TEXT NOT NULL,
        file_name TEXT NOT NULL, byte_length INTEGER NOT NULL, page_count INTEGER NOT NULL,
        fingerprint TEXT NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO assets_v2 SELECT * FROM assets;
        DROP TABLE assets;
        ALTER TABLE assets_v2 RENAME TO assets;
        CREATE INDEX assets_hash ON assets(sha256);
        CREATE TABLE arxiv_sources (
          base_id TEXT NOT NULL, revision INTEGER NOT NULL, asset_id TEXT NOT NULL UNIQUE REFERENCES assets(id),
          metadata TEXT NOT NULL, PRIMARY KEY(base_id,revision));
        CREATE TABLE arxiv_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        PRAGMA user_version=2;`);
      if (this.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("书库升级校验失败，已回滚。");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.db.exec("PRAGMA foreign_keys=ON"); }
  }

  private withSource(row: LibraryAsset): LibraryAsset {
    const github = this.db.prepare("SELECT metadata FROM github_sources WHERE asset_id=?").get(row.assetId) as { metadata: string } | undefined;
    if (github) return { ...row, githubSource: JSON.parse(github.metadata) as GitHubSource };
    const source = this.db.prepare("SELECT metadata FROM arxiv_sources WHERE asset_id=?").get(row.assetId) as { metadata: string } | undefined;
    if (!source) return row;
    const paper = JSON.parse(source.metadata) as ArxivPaper;
    return { ...row, title: paper.title, source: paper };
  }
  arxivAsset(baseId: string, revision: number): LibraryAsset | undefined {
    const row = this.db.prepare("SELECT asset_id FROM arxiv_sources WHERE base_id=? AND revision=?").get(baseId, revision) as { asset_id: string } | undefined;
    return row ? this.asset(row.asset_id) : undefined;
  }
  jobs(): ArxivJob[] {
    return (this.db.prepare("SELECT data FROM arxiv_jobs ORDER BY updated_at DESC").all() as { data: string }[]).map(r => JSON.parse(r.data));
  }
  saveJob(job: ArxivJob): void {
    this.db.prepare("INSERT INTO arxiv_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at")
      .run(job.jobId, JSON.stringify(job), job.updatedAt);
  }

  list(): LibraryEntry[] {
    return (this.db.prepare(`${assetQuery} LEFT JOIN reading_positions r ON r.asset_id=a.id
      ORDER BY COALESCE(r.updated_at,a.created_at) DESC`).all() as LibraryAsset[]).map((row) => ({
      ...this.withSource(row), lastPage: this.state(String(row.assetId)).page,
    })) as unknown as LibraryEntry[];
  }
  asset(assetId: string): LibraryAsset {
    const row = this.db.prepare(`${assetQuery} WHERE a.id=?`).get(assetId);
    if (!row) throw new Error("未找到这份书库资料。");
    return this.withSource(row as unknown as LibraryAsset);
  }
  filePath(assetId: string): string { return path.join(this.directory, "blobs", this.asset(assetId).sha256); }
  async verify(assetId: string): Promise<LibraryAsset> {
    const asset = this.asset(assetId);
    if (await hashFile(this.filePath(assetId)) !== asset.sha256) throw new Error("书库原件校验失败，请重新导入原文件。");
    return asset;
  }
  private page(assetId: string, page: number) {
    if (!Number.isInteger(page) || page < 1 || page > this.asset(assetId).pageCount) throw new Error("页码不在这份 PDF 的范围内。");
  }
  state(assetId: string): ReadingState {
    this.asset(assetId);
    const row = this.db.prepare("SELECT page FROM reading_positions WHERE asset_id=?").get(assetId) as { page: number } | undefined;
    return { page: row ? Number(row.page) : null,
      bookmarks: this.db.prepare("SELECT page,title FROM bookmarks WHERE asset_id=? ORDER BY page").all(assetId) as unknown as Bookmark[] };
  }
  setPage(assetId: string, page: number): ReadingState {
    this.page(assetId, page);
    this.db.prepare(`INSERT INTO reading_positions VALUES(?,?,?) ON CONFLICT(asset_id)
      DO UPDATE SET page=excluded.page,updated_at=excluded.updated_at`).run(assetId, page, new Date().toISOString());
    return this.state(assetId);
  }
  bookmark(assetId: string, action: "add" | "remove", page: number, title = ""): ReadingState {
    this.page(assetId, page);
    if (action === "remove") this.db.prepare("DELETE FROM bookmarks WHERE asset_id=? AND page=?").run(assetId, page);
    else this.db.prepare(`INSERT INTO bookmarks VALUES(?,?,?) ON CONFLICT(asset_id,page)
      DO UPDATE SET title=excluded.title`).run(assetId, page, title.trim().slice(0, 200) || `第 ${page} 页`);
    return this.state(assetId);
  }
  migrate(assetId: string, clientId: string, fingerprint: string, state: ReadingState): ReadingState {
    if (fingerprint !== this.asset(assetId).fingerprint) throw new Error("旧记录指纹与当前文件不一致，未迁移。");
    const matches = this.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE fingerprint=?").get(fingerprint) as { count: number };
    if (matches.count !== 1) throw new Error("旧指纹对应多份不同文件，无法确定归属，未自动迁移。");
    if (state.page !== null) this.page(assetId, state.page);
    for (const bookmark of state.bookmarks) this.page(assetId, bookmark.page);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db.prepare("INSERT OR IGNORE INTO legacy_migrations VALUES(?,?,?)").run(assetId, clientId, fingerprint);
      if (inserted.changes) {
        if (state.page !== null) this.db.prepare("INSERT OR IGNORE INTO reading_positions VALUES(?,?,?)").run(assetId, state.page, new Date().toISOString());
        for (const b of state.bookmarks) this.db.prepare("INSERT OR IGNORE INTO bookmarks VALUES(?,?,?)").run(assetId, b.page, b.title.trim().slice(0, 200) || `第 ${b.page} 页`);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.state(assetId);
  }

  beginUpload(name: string, size: number): { uploadId: string } {
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_IMPORT_BYTES) throw new Error("请选择不超过 512 MB 的 PDF 文件。");
    if (!name.toLowerCase().endsWith(".pdf")) throw new Error("目前书库只支持 PDF 文件。");
    if (this.uploads.size >= 8) throw new Error("尚有未完成的导入，请完成或取消后重试。");
    const uploadId = randomUUID();
    const target = path.join(this.directory, "tmp", `${uploadId}.part`);
    fs.writeFileSync(target, "", { flag: "wx" });
    this.uploads.set(uploadId, { path: target, name: path.basename(name.replace(/\\/g, "/")), size, offset: 0, busy: false });
    return { uploadId };
  }
  private upload(id: string) {
    const upload = this.uploads.get(id);
    if (!upload) throw new Error("导入任务已失效，请重新选择文件。");
    if (upload.busy) throw new Error("导入任务正在处理，请勿同时提交。");
    return upload;
  }
  append(id: string, offset: number, bytes: string) {
    const upload = this.upload(id);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytes)) throw new Error("无效的文件数据。");
    const data = Buffer.from(bytes, "base64");
    if (!data.length || data.length > UPLOAD_CHUNK_BYTES || offset !== upload.offset || offset + data.length > upload.size) throw new Error("文件分块位置或大小不正确。");
    fs.appendFileSync(upload.path, data);
    upload.offset += data.length;
    return { receivedBytes: upload.offset };
  }
  cancel(id: string) {
    const upload = this.upload(id);
    fs.rmSync(upload.path, { force: true });
    this.uploads.delete(id);
  }
  async finish(id: string): Promise<LibraryAsset> {
    const upload = this.upload(id);
    if (upload.offset !== upload.size) throw new Error("文件尚未完整传输。");
    upload.busy = true;
    try { return await this.commitFile(upload.path, upload.name); }
    finally { fs.rmSync(upload.path, { force: true }); this.uploads.delete(id); }
  }
  /** The MCP boundary checks the existing local-file allowlist before calling. */
  async importLocal(filePath: string): Promise<LibraryAsset> {
    const size = (await fs.promises.stat(filePath)).size;
    const { uploadId } = this.beginUpload(path.basename(filePath), size);
    const upload = this.uploads.get(uploadId)!;
    upload.busy = true;
    try {
      await fs.promises.copyFile(filePath, upload.path);
      return await this.commitFile(upload.path, upload.name);
    } finally { fs.rmSync(upload.path, { force: true }); this.uploads.delete(uploadId); }
  }
  async importArxiv(staged: string, source: ArxivPaper, signal: AbortSignal): Promise<LibraryAsset> {
    return this.commitFile(staged, `${source.id.replaceAll("/", "_")}.pdf`, source, signal);
  }
  async importGithub(staged: string, source: GitHubSource): Promise<LibraryAsset> {
    const byteLength = (await fs.promises.stat(staged)).size;
    if (byteLength > (source.format === "pdf" ? 100 * 1024 * 1024 : 1024 * 1024)) throw new Error("GitHub 文件超过大小上限。");
    const sha256 = await hashFile(staged);
    const info = source.format === "pdf" ? await this.inspectPdf(staged)
      : { pageCount: (await fs.promises.readFile(staged, "utf8")).split("\n").length, fingerprint: sha256 };
    const blob = path.join(this.directory, "blobs", sha256);
    try { await fs.promises.link(staged, blob); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (await hashFile(blob) !== sha256) throw new Error("书库原件校验失败，未覆盖。");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const key = source.repository.toLowerCase();
      const existing = this.db.prepare("SELECT asset_id FROM github_sources WHERE repository=? AND file_path=? AND commit_sha=?")
        .get(key, source.path, source.commit) as { asset_id: string } | undefined;
      if (existing) {
        const asset = this.asset(existing.asset_id);
        if (asset.sha256 !== sha256) throw new Error("同一 GitHub 提交的文件内容不同，未覆盖。");
        this.db.exec("COMMIT"); return asset;
      }
      const previous = this.db.prepare(`SELECT v.document_id FROM github_sources s JOIN assets a ON a.id=s.asset_id
        JOIN versions v ON v.id=a.version_id WHERE s.repository=? AND s.file_path=? LIMIT 1`).get(key, source.path) as { document_id: string } | undefined;
      const documentId = previous?.document_id ?? randomUUID(), versionId = randomUUID(), assetId = randomUUID();
      if (!previous) this.db.prepare("INSERT INTO documents VALUES(?,?)").run(documentId, `${source.repository} / ${source.path}`);
      this.db.prepare("INSERT INTO versions VALUES(?,?)").run(versionId, documentId);
      this.db.prepare("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)").run(assetId, versionId, sha256, path.posix.basename(source.path), byteLength, info.pageCount, info.fingerprint, new Date().toISOString());
      this.db.prepare("INSERT INTO github_sources VALUES(?,?,?,?,?)").run(key, source.path, source.commit, assetId, JSON.stringify(source));
      this.db.exec("COMMIT"); return this.asset(assetId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async readText(assetId: string): Promise<string> {
    const asset = await this.verify(assetId);
    if (!asset.githubSource || asset.githubSource.format === "pdf") throw new Error("此资料不是 GitHub 文本文件。");
    return fs.promises.readFile(this.filePath(assetId), "utf8");
  }
  private async commitFile(staged: string, fileName: string, source?: ArxivPaper, signal?: AbortSignal): Promise<LibraryAsset> {
    const byteLength = (await fs.promises.stat(staged)).size;
    if (!byteLength || byteLength > MAX_IMPORT_BYTES) throw new Error("PDF 文件大小超出支持范围。");
    const { pageCount, fingerprint } = await this.inspectPdf(staged);
    const sha256 = await hashFile(staged);
    signal?.throwIfAborted();
    const blob = path.join(this.directory, "blobs", sha256);
    try { await fs.promises.link(staged, blob); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (await hashFile(blob) !== sha256) throw new Error("书库中已有同名原件但校验失败，未覆盖。");
    signal?.throwIfAborted();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = (source
        ? this.db.prepare("SELECT asset_id AS id FROM arxiv_sources WHERE base_id=? AND revision=?").get(source.baseId, source.version)
        : this.db.prepare("SELECT id FROM assets WHERE sha256=? ORDER BY created_at LIMIT 1").get(sha256)) as { id: string } | undefined;
      const assetId = existing ? String(existing.id) : randomUUID();
      if (source && existing && this.asset(assetId).sha256 !== sha256) throw new Error("同一 arXiv 版本返回了不同文件，未覆盖已保存的原件。");
      if (!existing) {
        const previous = source ? this.db.prepare(`SELECT v.document_id FROM arxiv_sources s JOIN assets a ON a.id=s.asset_id
          JOIN versions v ON v.id=a.version_id WHERE s.base_id=? LIMIT 1`).get(source.baseId) as { document_id: string } | undefined : undefined;
        const documentId = previous?.document_id ?? randomUUID(), versionId = randomUUID();
        if (!previous) this.db.prepare("INSERT INTO documents VALUES(?,?)").run(documentId, source?.title ?? fileName);
        this.db.prepare("INSERT INTO versions VALUES(?,?)").run(versionId, documentId);
        this.db.prepare("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)").run(assetId, versionId, sha256, fileName, byteLength, pageCount, fingerprint, new Date().toISOString());
        if (source) this.db.prepare("INSERT INTO arxiv_sources VALUES(?,?,?,?)").run(source.baseId, source.version, assetId, JSON.stringify(source));
      }
      this.db.exec("COMMIT");
      return this.asset(assetId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() { this.db.close(); }
}
