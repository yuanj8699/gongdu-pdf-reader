import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn("codex.exe", ["app-server", "--stdio"], {
  cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
const pending = new Map();
let nextId = 0;
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk.toString(); });
function failPending(error) {
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
  pending.clear();
}
child.on("error", failPending);
child.on("exit", code => { failPending(new Error(`Codex app-server exited (${code})`)); });
readline.createInterface({ input: child.stdout }).on("line", line => {
  const response = JSON.parse(line);
  const request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id);
  clearTimeout(request.timer);
  if (response.error) request.reject(new Error(JSON.stringify(response.error)));
  else request.resolve(response.result);
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex app-server timeout: ${method}`));
    }, 35000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

try {
  await rpc("initialize", {
    clientInfo: { name: "gongdu_plugin_check", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const { plugin } = await rpc("plugin/read", {
    marketplacePath: path.join(root, ".local-plugin/.agents/plugins/marketplace.json"),
    pluginName: "gongdu",
  });
  assert.equal(plugin.summary.installed, true);
  assert.equal(plugin.summary.enabled, true);
  assert.equal(plugin.summary.interface.displayName, "共读");
  assert.ok(plugin.mcpServers.includes("gongdu"), "Codex must parse the packaged MCP connection");
  const { thread } = await rpc("thread/start", {
    cwd: root, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
  });
  const { data } = await rpc("mcpServerStatus/list", {
    threadId: thread.id, serverName: "gongdu", detail: "toolsAndAuthOnly",
  });
  const server = data.find(item => item.name === "gongdu");
  assert.ok(server?.tools?.open_library, "The installed plugin must expose its library tool");
  const library = await rpc("mcpServer/tool/call", {
    threadId: thread.id, server: "gongdu", tool: "open_library", arguments: {},
  });
  assert.ok(!library.isError);
  assert.equal(library.structuredContent?.kind, "library");
  const resource = await rpc("mcpServer/resource/read", {
    threadId: thread.id, server: "gongdu", uri: server.tools.open_library._meta.ui.resourceUri,
  });
  assert.match(resource.contents[0].mimeType, /mcp-app/);
  assert.ok(resource.contents[0].text.length > 1000, "The plugin must return the real interactive reader");
  const denied = await rpc("mcpServer/tool/call", {
    threadId: thread.id, server: "gongdu", tool: "display_pdf",
    arguments: { url: path.join(root, "package.json") },
  });
  assert.equal(denied.isError, true, "The plugin must reject unregistered files");
  console.log("PASS: installed Gongdu plugin metadata, Codex tool discovery, library call, reader HTML, and file-access boundary");
} catch (error) {
  // Report relevant parser diagnostics without dumping unrelated service logs.
  console.error(stderr.split("\n").filter(line => line.includes("failed to parse plugin MCP server")).join("\n"));
  throw error;
} finally {
  child.stdin.end();
  child.kill();
}
