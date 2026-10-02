import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { OcrService, OCR_MAX_BYTES } from "./ocr.js";

export function registerOcrTools(server: McpServer, service = new OcrService()) {
  const invoke = (operation: () => unknown | Promise<unknown>): Promise<CallToolResult> =>
    Promise.resolve().then(operation).then(data => ({
      content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown>,
    })).catch((error: unknown) => ({ isError: true, content: [{ type: "text" as const,
      text: error instanceof Error ? error.message : String(error) }] }));
  const metadata = { ui: { visibility: ["app" as const] } };
  registerAppTool(server, "reader_ocr_capabilities", {
    description: "Check local Windows OCR and installed recognition languages. Does not upload documents or download models.",
    inputSchema: z.object({}), _meta: metadata, annotations: { readOnlyHint: true },
  }, () => invoke(() => service.capabilities()));
  registerAppTool(server, "reader_ocr_start", {
    description: "Recognize one PNG page rendered by the reader using the local Windows OCR engine. Returns a job ID; poll reader_ocr_status for text and normalized word boxes. No network or file path input.",
    inputSchema: z.object({ pngBase64: z.string().min(1).max(Math.ceil(OCR_MAX_BYTES / 3) * 4), language: z.string().min(2).max(64).optional() }),
    _meta: metadata, annotations: { destructiveHint: false, openWorldHint: false },
  }, ({ pngBase64, language }) => invoke(() => service.start(pngBase64, language)));
  registerAppTool(server, "reader_ocr_status", {
    description: "Read the result or failure of a local OCR job. The eight most recent results are retained for up to five minutes.",
    inputSchema: z.object({ jobId: z.string().uuid() }), _meta: metadata, annotations: { readOnlyHint: true },
  }, ({ jobId }) => invoke(() => service.status(jobId)));
  registerAppTool(server, "reader_ocr_cancel", {
    description: "Stop a running local OCR job and release its page image.",
    inputSchema: z.object({ jobId: z.string().uuid() }), _meta: metadata,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ jobId }) => invoke(() => service.cancel(jobId)));
  const previousClose = server.server.onclose;
  server.server.onclose = () => { service.dispose(); previousClose?.(); };
  return service;
}
