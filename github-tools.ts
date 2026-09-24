import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { GitHubService } from "./github.js";

export function registerGithubTools(server: McpServer, github: GitHubService) {
  const invoke = async (operation: () => unknown | Promise<unknown>): Promise<CallToolResult> => {
    try {
      const data = await operation() as Record<string, unknown>;
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
  };
  const repository = z.string().min(1).max(300), commit = z.string().regex(/^[a-f0-9]{40}$/), filePath = z.string().max(2000);
  server.registerTool("github_account", { description: "Check the reader's local GitHub CLI authorization. Never ask for tokens in chat. Login via gh auth login in the local terminal.",
    inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: true } }, () => invoke(() => github.client.account()));
  server.registerTool("github_repositories", { description: "Search GitHub repositories or list the local authorized account's starred/own repositories. Read only, paginated.",
    inputSchema: z.object({ kind: z.enum(["search", "starred", "mine"]), query: z.string().max(500).default(""), page: z.number().int().min(1).max(100).default(1) }),
    annotations: { readOnlyHint: true, openWorldHint: true } }, ({ kind, query, page }) => invoke(() => github.client.repositories(kind, query, page)));
  server.registerTool("github_resolve", { description: "Resolve a GitHub repository homepage or owner/repo plus optional branch/tag/ref to an immutable commit. Default: default branch.",
    inputSchema: z.object({ repository, ref: z.string().max(300).optional() }), annotations: { readOnlyHint: true, openWorldHint: true } },
    ({ repository, ref }) => invoke(() => github.client.resolve(repository, ref)));
  server.registerTool("github_directory", { description: "Browse a repository directory at an exact commit. Symbolic links and submodules are not opened.",
    inputSchema: z.object({ repository, commit, path: filePath.default("") }), annotations: { readOnlyHint: true, openWorldHint: true } },
    ({ repository, commit, path }) => invoke(() => github.client.directory(repository, commit, path)));
  server.registerTool("github_import_file", { description: "Import one GitHub PDF (up to 100 MB) or UTF-8 Markdown/code file (up to 1 MB) from an exact commit into the local library. Reuses an existing exact version. PDF opens via display_pdf; text opens via library_read_text. Never downloads the whole repository.",
    inputSchema: z.object({ repository, commit, path: filePath.min(1) }), annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true } },
    ({ repository, commit, path }) => invoke(() => github.importFile(repository, commit, path)));
}
