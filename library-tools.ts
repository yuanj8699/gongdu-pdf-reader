import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LibraryService, MAX_IMPORT_BYTES } from "./library.js";

export const LibraryAssetSchema = z.object({
  documentId: z.string(), versionId: z.string(), assetId: z.string(), title: z.string(),
  fileName: z.string(), sha256: z.string(), byteLength: z.number(), pageCount: z.number(),
  fingerprint: z.string(), createdAt: z.string(),
  githubSource: z.object({ provider: z.literal("github"), repository: z.string(), commit: z.string(), path: z.string(),
    blobSha: z.string(), url: z.string(), format: z.enum(["pdf", "markdown", "code"]) }).optional(),
  source: z.object({ provider: z.literal("arxiv"), id: z.string(), baseId: z.string(), version: z.number(),
    title: z.string(), authors: z.array(z.string()), summary: z.string(), published: z.string(), updated: z.string(),
    abstractUrl: z.string(), pdfUrl: z.string() }).optional(),
});

export function registerLibraryTools(server: McpServer, library: LibraryService, resourceUri: string,
  localPath: (input: string) => string, arxivEnabled = false, githubEnabled = false) {
  const invoke = (operation: () => unknown | Promise<unknown>): Promise<CallToolResult> =>
    Promise.resolve().then(operation).then((data) => ({
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      structuredContent: data as Record<string, unknown>,
    })).catch((error: unknown) => ({ isError: true, content: [{ type: "text" as const,
      text: error instanceof Error ? error.message : String(error) }] }));
  const appOnly = { ui: { visibility: ["app" as const] } };
  registerAppTool(server, "open_library", {
    title: "PDF 阅读器", description: "Open the persistent local PDF library in the reader. Users can import PDFs and continue reading.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri }, "openai/ui": { entrypoints: [{ type: "thread" }] } },
  }, async () => ({ content: [{ type: "text", text: "本地共读书库" }], structuredContent: { kind: "library" }, _meta: { libraryEnabled: true, arxivEnabled, githubEnabled } }));
  server.registerTool("library_list", {
    description: "List library files. Open PDFs with display_pdf(assetId); GitHub Markdown/code with library_read_text(assetId).", inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, () => invoke(() => ({ entries: library.list() })));
  server.registerTool("library_get_asset", {
    description: "Get one library file's metadata and format.", inputSchema: z.object({ assetId: z.string() }), annotations: { readOnlyHint: true },
  }, ({ assetId }) => invoke(() => library.asset(assetId)));
  registerAppTool(server, "library_read_text", {
    description: "Open an imported GitHub Markdown/code file in the reader, preserving its exact commit and source line numbers.",
    inputSchema: z.object({ assetId: z.string() }), annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri } },
  }, async ({ assetId }) => {
    const result = await invoke(async () => ({ kind: "text", asset: library.asset(assetId), text: await library.readText(assetId), state: library.state(assetId) }));
    return { ...result, _meta: { libraryEnabled: true, arxivEnabled, githubEnabled } };
  });
  server.registerTool("library_import_pdf", {
    description: "Copy an explicitly authorized local PDF into the persistent library; identical bytes reuse the existing asset. Other local PDFs can be chosen by the user in the library's file picker.",
    inputSchema: z.object({ path: z.string() }),
    annotations: { destructiveHint: false, idempotentHint: true },
  }, ({ path }) => invoke(() => library.importLocal(localPath(path))));
  server.registerTool("library_get_state", {
    description: "Read a library asset's saved page and bookmarks.", inputSchema: z.object({ assetId: z.string() }),
    annotations: { readOnlyHint: true },
  }, ({ assetId }) => invoke(() => library.state(assetId)));
  registerAppTool(server, "library_set_page", {
    description: "Save the reading position for one asset.",
    inputSchema: z.object({ assetId: z.string(), page: z.number().int().positive() }), _meta: appOnly,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, ({ assetId, page }) => invoke(() => library.setPage(assetId, page)));
  registerAppTool(server, "library_bookmark", {
    description: "Add or remove one bookmark without overwriting other windows' bookmarks.",
    inputSchema: z.object({ assetId: z.string(), action: z.enum(["add", "remove"]), page: z.number().int().positive(), title: z.string().max(200).default("") }), _meta: appOnly,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, ({ assetId, action, page, title }) => invoke(() => library.bookmark(assetId, action, page, title)));
  registerAppTool(server, "library_migrate_state", {
    description: "Idempotently migrate the current PDF's matching legacy browser reading state, preserving existing backend state.",
    inputSchema: z.object({ assetId: z.string(), clientId: z.string().uuid(), fingerprint: z.string().min(1).max(256),
      page: z.number().int().positive().nullable(), bookmarks: z.array(z.object({ page: z.number().int().positive(), title: z.string().max(200) })).max(10000) }), _meta: appOnly,
  }, ({ assetId, clientId, fingerprint, ...state }) => invoke(() => library.migrate(assetId, clientId, fingerprint, state)));
  registerAppTool(server, "library_begin_upload", {
    description: "Start importing a PDF explicitly selected in the reader's file picker.",
    inputSchema: z.object({ fileName: z.string().min(1).max(255), size: z.number().int().positive().max(MAX_IMPORT_BYTES) }), _meta: appOnly,
  }, ({ fileName, size }) => invoke(() => library.beginUpload(fileName, size)));
  registerAppTool(server, "library_upload_chunk", {
    description: "Append the next PDF file chunk to a local import.",
    inputSchema: z.object({ uploadId: z.string().uuid(), offset: z.number().int().nonnegative(), bytes: z.string().max(699052) }), _meta: appOnly,
  }, ({ uploadId, offset, bytes }) => invoke(() => library.append(uploadId, offset, bytes)));
  registerAppTool(server, "library_finish_upload", {
    description: "Validate and commit a fully uploaded PDF to the library.",
    inputSchema: z.object({ uploadId: z.string().uuid() }), _meta: appOnly,
  }, ({ uploadId }) => invoke(() => library.finish(uploadId)));
  registerAppTool(server, "library_cancel_upload", {
    description: "Discard an unfinished local file import.",
    inputSchema: z.object({ uploadId: z.string().uuid() }), _meta: appOnly,
  }, ({ uploadId }) => invoke(() => { library.cancel(uploadId); return { cancelled: true }; }));
}
