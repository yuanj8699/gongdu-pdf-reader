import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { LibraryService } from "./library.js";

export interface LocalPdf { relativePath: string; byteLength: number }
export interface DirectoryScan { root: string; files: LocalPdf[]; skipped: string[]; truncated: boolean }
export class LocalLibrary {
  readonly roots: string[];
  constructor(roots: string[], private library: LibraryService) { this.roots = [...new Set(roots.map(root => path.resolve(root)))]; }
  private async root(requested: string) {
    const root = path.resolve(requested);
    if (!this.roots.includes(root)) throw new Error("该文件夹尚未连接到阅读器。");
    return fs.realpath(root);
  }
  async scan(requested: string): Promise<DirectoryScan> {
    const root = await this.root(requested);
    const result: DirectoryScan = { root: path.resolve(requested), files: [], skipped: [], truncated: false };
    let visited = 0;
    const walk = async (directory: string) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (result.files.length >= 1000 || ++visited > 20000) { result.truncated = true; return; }
        const target = path.join(directory, entry.name);
        const relativePath = path.relative(root, target);
        if (entry.isSymbolicLink()) { result.skipped.push(`${relativePath}：跳过链接`); continue; }
        try {
          const real = await fs.realpath(target);
          this.inside(root, real);
          if (entry.isDirectory()) await walk(real);
          else if (entry.isFile() && /\.pdf$/i.test(entry.name)) result.files.push({ relativePath, byteLength: (await fs.stat(real)).size });
        } catch (error) { result.skipped.push(`${relativePath}：${error instanceof Error ? error.message : String(error)}`); }
        if (result.truncated) return;
      }
    };
    await walk(root);
    result.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return result;
  }
  private inside(root: string, target: string) {
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("文件超出已连接文件夹的范围。");
  }
  async import(requested: string, relativePath: string) {
    const root = await this.root(requested);
    if (path.isAbsolute(relativePath) || !/\.pdf$/i.test(relativePath)) throw new Error("请选择书库中的 PDF 文件。");
    const target = path.resolve(root, relativePath);
    this.inside(root, target);
    const real = await fs.realpath(target); this.inside(root, real);
    if (!(await fs.stat(real)).isFile()) throw new Error("所选路径不是 PDF 文件。");
    return this.library.importLocal(real);
  }
}

export function registerLocalLibraryTools(server: McpServer, local: LocalLibrary) {
  const invoke = async (operation: () => unknown | Promise<unknown>): Promise<CallToolResult> => {
    try {
      const data = await operation() as Record<string, unknown>;
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
  };
  server.registerTool("library_directories", {
    description: "List explicitly connected read-only local PDF folders.", inputSchema: z.object({}), annotations: { readOnlyHint: true },
  }, () => invoke(() => ({ roots: local.roots })));
  server.registerTool("library_scan_directory", {
    description: "Scan one connected PDF folder recursively, without modifying it. Skips links; reports scan limits and unreadable entries. Re-scan to discover added files.",
    inputSchema: z.object({ root: z.string() }), annotations: { readOnlyHint: true },
  }, ({ root }) => invoke(() => local.scan(root)));
  server.registerTool("library_import_directory_pdf", {
    description: "Copy a PDF from an explicitly connected folder into the persistent library. Pass relativePath from library_scan_directory. Identical content reuses an existing asset. Source remains unchanged.",
    inputSchema: z.object({ root: z.string(), relativePath: z.string() }), annotations: { destructiveHint: false, idempotentHint: true },
  }, ({ root, relativePath }) => invoke(() => local.import(root, relativePath)));
}
