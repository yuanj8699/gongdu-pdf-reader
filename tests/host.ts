// A real MCP Apps AppBridge with a test-only host. No model answer is simulated.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const iframe = document.querySelector<HTMLIFrameElement>("iframe")!;
const initialResult = await fetch(`/initial${window.location.search}`).then((response) => response.json());
const observations = { contexts: [] as unknown[], messages: [] as unknown[], downloads: [] as unknown[], displayModes: [] as string[], ready: false, rejectNextMessage: false, rejectNextDisplayMode: false };
Object.assign(window, { observations });
const bridge = new AppBridge(null, { name: "Reader smoke-test host", version: "1.0.0" }, {
  serverTools: {}, logging: {}, downloadFile: {},
  updateModelContext: { text: {} }, message: { text: {} },
}, {
  hostContext: {
    toolInfo: { id: initialResult._meta.viewUUID, tool: { name: "display_pdf", inputSchema: { type: "object" } } },
    theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"],
    locale: "zh-CN", platform: "web",
    containerDimensions: { width: 1100, height: 850 },
  },
});
bridge.oncalltool = async (params) => {
  const response = await fetch("/tool", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
bridge.onupdatemodelcontext = async (params) => { observations.contexts.push(params); return {}; };
bridge.onmessage = async (params) => {
  observations.messages.push(params);
  if (observations.rejectNextMessage) {
    observations.rejectNextMessage = false;
    return { isError: true };
  }
  return {};
};
bridge.ondownloadfile = async (params) => { observations.downloads.push(params); return {}; };
bridge.onrequestdisplaymode = async ({ mode }) => {
  observations.displayModes.push(mode);
  if (observations.rejectNextDisplayMode) {
    observations.rejectNextDisplayMode = false;
    return { mode: "inline" };
  }
  bridge.setHostContext({ displayMode: mode });
  return { mode };
};
bridge.oninitialized = async () => {
  await bridge.sendToolInput({ arguments: { url: initialResult.structuredContent.url } });
  await bridge.sendToolResult(initialResult);
  observations.ready = true;
};
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
iframe.src = "/app";
