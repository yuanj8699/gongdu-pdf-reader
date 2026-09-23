import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ArxivService } from "./arxiv.js";
import { ACTIVE_IMPORT_STATES } from "./src/arxiv-types.js";

export function registerArxivTools(server: McpServer, arxiv: ArxivService) {
  const invoke = async (operation: () => unknown | Promise<unknown>): Promise<CallToolResult> => {
    try {
      const data = await operation() as Record<string, unknown>;
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
  };
  server.registerTool("arxiv_search", {
    description: "Search arXiv by keywords, advanced query, official URL or paper ID. Returns explicit version IDs and metadata; nothing is downloaded. Use arxiv_resolve for a chosen older version, then arxiv_download.",
    inputSchema: z.object({ query: z.string().min(1).max(500), start: z.number().int().min(0).max(1000).default(0) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, ({ query, start }) => invoke(() => arxiv.client.search(query, start)));
  server.registerTool("arxiv_resolve", {
    description: "Get metadata for an arXiv ID (optionally vN). An unversioned ID resolves to the latest explicit version; download must use that pinned ID.",
    inputSchema: z.object({ id: z.string().min(1).max(200) }), annotations: { readOnlyHint: true, openWorldHint: true },
  }, ({ id }) => invoke(async () => ({ paper: await arxiv.client.resolve(id) })));
  server.registerTool("arxiv_download", {
    description: "Start downloading a specific arXiv version (ID must end in vN) into the local library. Returns jobId immediately. Repeated active/completed requests reuse the job. The library UI shows progress; do not repeatedly poll from the model or report queued jobs as completed.",
    inputSchema: z.object({ id: z.string().min(1).max(200) }), annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ id }) => invoke(() => arxiv.start(id)));
  server.registerTool("arxiv_jobs", {
    description: "Read a download job, or recent jobs with progress and failures. Completed jobs include assetId for display_pdf. Cancelled, failed, or interrupted jobs can be retried with arxiv_download on the same pinned version.",
    inputSchema: z.object({ jobId: z.string().uuid().optional() }), annotations: { readOnlyHint: true },
  }, ({ jobId }) => invoke(() => jobId ? arxiv.get(jobId) : { jobs: arxiv.list().filter((job, index) => index < 30 || ACTIVE_IMPORT_STATES.includes(job.state)) }));
  server.registerTool("arxiv_cancel", {
    description: "Cancel an unfinished arXiv download. Completed library files remain available.",
    inputSchema: z.object({ jobId: z.string().uuid() }), annotations: { destructiveHint: false, idempotentHint: true },
  }, ({ jobId }) => invoke(() => arxiv.cancel(jobId)));
}
