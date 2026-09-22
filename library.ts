import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Bookmark, LibraryAsset, LibraryEntry, ReadingState } from "./src/library-types.js";

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
    if (version > 1) { this.db.close(); throw new Error("书库版本较新，请使用新版阅读器。"); }
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
    // Remove only stale staging files created by this service, never live imports.
    for (const name of fs.readdirSync(path.join(this.directory, "tmp"))) {
      if (!/^[a-f0-9-]{36}\.part$/.test(name)) continue;
      const file = path.join(this.directory, "tmp", name);
      if (Date.now() - fs.statSync(file).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(file);
    }
  }

  list(): LibraryEntry[] {
    return (this.db.prepare(`${assetQuery} LEFT JOIN reading_positions r ON r.asset_id=a.id
      ORDER BY COALESCE(r.updated_at,a.created_at) DESC`).all() as LibraryAsset[]).map((row) => ({
      ...row, lastPage: this.state(String(row.assetId)).page,
    })) as unknown as LibraryEntry[];
  }
  asset(assetId: string): LibraryAsset {
    const row = this.db.prepare(`${assetQuery} WHERE a.id=?`).get(assetId);
    if (!row) throw new Error("未找到这份书库资料。");
    return row as unknown as LibraryAsset;
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
  private async commitFile(staged: string, fileName: string): Promise<LibraryAsset> {
    const byteLength = (await fs.promises.stat(staged)).size;
    if (!byteLength || byteLength > MAX_IMPORT_BYTES) throw new Error("PDF 文件大小超出支持范围。");
    const { pageCount, fingerprint } = await this.inspectPdf(staged);
    const sha256 = await hashFile(staged);
    const blob = path.join(this.directory, "blobs", sha256);
    try { await fs.promises.link(staged, blob); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (await hashFile(blob) !== sha256) throw new Error("书库中已有同名原件但校验失败，未覆盖。");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT id FROM assets WHERE sha256=?").get(sha256) as { id: string } | undefined;
      const assetId = existing ? String(existing.id) : randomUUID();
      if (!existing) {
        const documentId = randomUUID(), versionId = randomUUID();
        this.db.prepare("INSERT INTO documents VALUES(?,?)").run(documentId, fileName);
        this.db.prepare("INSERT INTO versions VALUES(?,?)").run(versionId, documentId);
        this.db.prepare("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)").run(assetId, versionId, sha256, fileName, byteLength, pageCount, fingerprint, new Date().toISOString());
      }
      this.db.exec("COMMIT");
      return this.asset(assetId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() { this.db.close(); }
}
