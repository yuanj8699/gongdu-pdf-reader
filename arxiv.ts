import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { LibraryService, MAX_IMPORT_BYTES } from "./library.js";
import { ACTIVE_IMPORT_STATES, type ArxivJob, type ArxivPaper } from "./src/arxiv-types.js";

export function arxivId(input: string): { baseId: string; version?: number; id: string } {
  let value = input.trim().replace(/^arxiv:\s*/i, "");
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(url.hostname) || url.username || url.password || url.port
      || url.search || url.hash || !/^\/(abs|pdf)\//.test(url.pathname)) throw new Error("请输入 arXiv 编号或官方论文链接。");
    value = url.pathname.replace(/^\/(abs|pdf)\//, "").replace(/\.pdf$/, "");
  }
  const match = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v([1-9]\d{0,3}))?$/.exec(value);
  if (!match) throw new Error("arXiv 编号格式不正确，例如 1706.03762v1。");
  return { baseId: match[1], version: match[2] ? Number(match[2]) : undefined, id: value };
}

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false,
  isArray: (name) => ["entry", "author", "link"].includes(name) });
async function* responseChunks(response: Response) {
  if (!response.body) throw new Error("arXiv 未返回数据。");
  const reader = response.body.getReader();
  try {
    while (true) { const result = await reader.read(); if (result.done) break; yield result.value; }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
export function parseArxivFeed(xml: string): { papers: ArxivPaper[]; total: number } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("arXiv 返回的 XML 无法解析。");
  const feed = parser.parse(xml).feed;
  if (!feed || typeof feed !== "object") throw new Error("arXiv 返回了非 Atom 数据。");
  const clean = (v: unknown) => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  const papers = (feed.entry ?? []).map((entry: any): ArxivPaper => {
    if (/\/api\/errors/.test(clean(entry.id))) throw new Error(`arXiv 查询失败：${clean(entry.summary)}`);
    let parsed = arxivId(clean(entry.id));
    if (!parsed.version) {
      const pdf = entry.link?.find((l: any) => l["@_title"] === "pdf");
      const pinned = arxivId(clean(pdf?.["@_href"]));
      if (pinned.baseId !== parsed.baseId) throw new Error("arXiv 论文与文件编号不一致。");
      parsed = pinned;
    }
    if (!parsed.version || !clean(entry.title)) throw new Error("arXiv 未返回确定版本或标题，未下载。");
    return { provider: "arxiv", id: parsed.id, baseId: parsed.baseId, version: parsed.version,
      title: clean(entry.title), summary: clean(entry.summary), authors: (entry.author ?? []).map((a: any) => clean(a.name)).filter(Boolean),
      published: clean(entry.published), updated: clean(entry.updated),
      abstractUrl: `https://arxiv.org/abs/${parsed.id}`, pdfUrl: `https://arxiv.org/pdf/${parsed.id}` };
  });
  const total = Number(feed.totalResults ?? papers.length);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("arXiv 返回的结果数量无效。");
  return { papers, total };
}

/** One connection, spaced requests. Downloads and API responses consume the queue until their bodies close. */
export class ArxivClient {
  private work: Promise<unknown> = Promise.resolve();
  private nextRequest = 0;
  constructor(private request: typeof fetch = fetch, private spacingMs = 3100) {}
  private serialized<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const task = this.work.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      await delay(Math.max(0, this.nextRequest - Date.now()), undefined, { signal });
      this.nextRequest = Date.now() + this.spacingMs;
      return operation();
    });
    this.work = task;
    return task;
  }
  private async response(url: string, signal: AbortSignal, pdfId?: string): Promise<Response> {
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await this.request(url, { signal, redirect: "manual", headers: {
        "User-Agent": "GongduReader/2.0 (personal research reader)", ...(pdfId ? { "Accept-Encoding": "identity" } : {}) } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const destination = new URL(response.headers.get("location") ?? "", url);
        await response.body?.cancel();
        if (!pdfId || destination.protocol !== "https:" || arxivId(destination.href).id !== pdfId
          || !destination.pathname.startsWith("/pdf/")) throw new Error("arXiv 返回了不匹配的下载跳转。");
        url = destination.href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(response.status === 429 ? "arXiv 请求受限，请稍后手动重试。" : `arXiv 请求失败（HTTP ${response.status}）。`);
      }
      return response;
    }
    throw new Error("arXiv 下载跳转次数过多。");
  }
  private feed(params: URLSearchParams, signal?: AbortSignal) {
    return this.serialized(async () => {
      const timeout = AbortSignal.timeout(30000);
      const response = await this.response(`https://export.arxiv.org/api/query?${params}`, signal ? AbortSignal.any([signal, timeout]) : timeout);
      const chunks: Uint8Array[] = []; let size = 0;
      if (!response.body) throw new Error("arXiv 未返回数据。");
      for await (const chunk of responseChunks(response)) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error("arXiv 元数据超过本次查询上限，请缩小查询范围。");
        chunks.push(chunk);
      }
      return parseArxivFeed(Buffer.concat(chunks).toString("utf8"));
    }, signal);
  }
  async search(query: string, start = 0) {
    if (!query.trim() || query.length > 500 || !Number.isInteger(start) || start < 0 || start > 1000) throw new Error("请输入 500 字以内的关键词；最多翻阅前 1000 条结果。");
    if (/^(?:https?:\/\/|arxiv:|\d{4}\.|[a-z-]+(?:\.[A-Z]{2})?\/\d)/i.test(query.trim())) {
      const id = arxivId(query);
      return { papers: [await this.resolve(id.id)], total: 1, start: 0 };
    }
    const expression = /\b(?:ti|au|abs|cat|all):/.test(query) ? query.trim() : `all:${query.trim()}`;
    const result = await this.feed(new URLSearchParams({ search_query: expression, start: String(start), max_results: "10", sortBy: "relevance" }));
    return { ...result, start };
  }
  async resolve(id: string, signal?: AbortSignal): Promise<ArxivPaper> {
    const wanted = arxivId(id);
    const { papers } = await this.feed(new URLSearchParams({ id_list: wanted.id, max_results: "1" }), signal);
    const paper = papers[0];
    if (!paper || paper.baseId !== wanted.baseId || (wanted.version && paper.version !== wanted.version)) throw new Error("未找到指定的 arXiv 论文版本。");
    return paper;
  }
  download(paper: ArxivPaper, destination: string, signal: AbortSignal, progress: (received: number, total: number | null) => void) {
    return this.serialized(async () => {
      const response = await this.response(`https://arxiv.org/pdf/${paper.id}`, AbortSignal.any([signal, AbortSignal.timeout(180000)]), paper.id);
      const size = Number(response.headers.get("content-length"));
      const total = size > 0 && Number.isSafeInteger(size) ? size : null;
      const type = response.headers.get("content-type") ?? "";
      if (total && total > MAX_IMPORT_BYTES || !/application\/(pdf|octet-stream)/i.test(type)) {
        await response.body?.cancel(); throw new Error("arXiv 未返回支持大小的 PDF（可能是错误页）。");
      }
      if (!response.body) throw new Error("arXiv PDF 内容为空。");
      let file;
      try { file = await fs.open(destination, "wx"); }
      catch (error) { await response.body.cancel(); throw error; }
      let received = 0;
      try {
        for await (const chunk of responseChunks(response)) {
          signal.throwIfAborted(); received += chunk.length;
          if (received > MAX_IMPORT_BYTES) throw new Error("PDF 超过 512 MB 上限。");
          await file.writeFile(chunk);
          progress(received, total);
        }
        if (!received || total && received !== total) throw new Error("PDF 下载不完整，请重试。");
      } finally { await file.close(); }
    }, signal);
  }
}

export class ArxivService {
  private jobs = new Map<string, ArxivJob>();
  private queue: Promise<void> = Promise.resolve();
  private controllers = new Map<string, AbortController>();
  constructor(private library: LibraryService, readonly client = new ArxivClient()) {
    for (const job of library.jobs()) {
      if (ACTIVE_IMPORT_STATES.includes(job.state)) {
        const asset = arxivId(job.requestedId);
        const completed = library.arxivAsset(asset.baseId, asset.version!);
        job.state = completed ? "completed" : "interrupted";
        job.assetId = completed?.assetId;
        job.error = completed ? undefined : "服务已重启，下载中断；可重新下载该固定版本。";
        job.updatedAt = new Date().toISOString(); library.saveJob(job);
      }
      this.jobs.set(job.jobId, job);
    }
  }
  list(): ArxivJob[] { return [...this.jobs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(j => ({ ...j })); }
  get(id: string): ArxivJob {
    const job = this.jobs.get(id); if (!job) throw new Error("未找到下载任务。"); return { ...job };
  }
  private update(job: ArxivJob, values: Partial<ArxivJob>) {
    Object.assign(job, values, { updatedAt: new Date().toISOString() }); this.library.saveJob(job);
  }
  start(id: string): ArxivJob {
    const parsed = arxivId(id);
    if (!parsed.version) throw new Error("请先查询论文并选择确定版本（例如 v1）再下载。");
    const previous = [...this.jobs.values()].find(j => j.requestedId === parsed.id && (ACTIVE_IMPORT_STATES.includes(j.state) || j.state === "completed"));
    if (previous) return { ...previous };
    if (this.controllers.size >= 8) throw new Error("已有 8 个待完成下载，请稍后再添加。");
    const existing = this.library.arxivAsset(parsed.baseId, parsed.version);
    const job: ArxivJob = { jobId: randomUUID(), requestedId: parsed.id, state: existing ? "completed" : "queued",
      receivedBytes: 0, totalBytes: null, updatedAt: new Date().toISOString(), ...(existing ? { assetId: existing.assetId, paper: existing.source } : {}) };
    this.jobs.set(job.jobId, job); this.library.saveJob(job);
    if (!existing) {
      const controller = new AbortController(); this.controllers.set(job.jobId, controller);
      this.queue = this.queue.then(() => this.run(job, controller)).catch(error => {
        // Storage errors are surfaced on this job instead of creating an unhandled background rejection.
        job.state = "failed"; job.error = `任务记录失败：${String(error)}`; this.controllers.delete(job.jobId);
        console.error("[arxiv]", job.error);
      });
    }
    return { ...job };
  }
  cancel(id: string) {
    const job = this.jobs.get(id); if (!job) throw new Error("未找到下载任务。");
    if (ACTIVE_IMPORT_STATES.includes(job.state)) {
      this.controllers.get(id)?.abort();
      this.update(job, { state: "cancelled", error: undefined });
    }
    return { ...job };
  }
  private async run(job: ArxivJob, controller: AbortController) {
    const staged = path.join(this.library.directory, "tmp", `${job.jobId}.part`);
    try {
      controller.signal.throwIfAborted(); this.update(job, { state: "resolving" });
      const paper = await this.client.resolve(job.requestedId, controller.signal);
      controller.signal.throwIfAborted(); this.update(job, { state: "downloading", paper });
      let savedAt = 0;
      await this.client.download(paper, staged, controller.signal, (receivedBytes, totalBytes) => {
        job.receivedBytes = receivedBytes; job.totalBytes = totalBytes;
        if (Date.now() - savedAt > 500) { this.update(job, {}); savedAt = Date.now(); }
      });
      controller.signal.throwIfAborted(); this.update(job, { state: "validating" });
      const asset = await this.library.importArxiv(staged, paper, controller.signal);
      this.update(job, { state: "completed", assetId: asset.assetId });
    } catch (error) {
      this.update(job, { state: controller.signal.aborted ? "cancelled" : "failed",
        error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : String(error) });
    } finally { this.controllers.delete(job.jobId); await fs.rm(staged, { force: true }); }
  }
  async close() { for (const controller of this.controllers.values()) controller.abort(); await this.queue; }
}
