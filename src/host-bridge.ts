import type { App } from "@modelcontextprotocol/ext-apps";
import { questionMessage, type ReadingContext, type TextReadingContext } from "./reading-context.js";

type Host = Pick<App, "callServerTool" | "sendMessage" | "updateModelContext" | "getHostContext" | "getHostCapabilities"
  | "requestDisplayMode" | "sendSizeChanged" | "openLink" | "downloadFile">;

/** MCP Apps is the only current transport. Lifecycle and app tool registration stay in the reader. */
export class HostBridge {
  private contextWork: Promise<unknown> = Promise.resolve();
  constructor(private host: Host) {}
  callTool: App["callServerTool"] = (...args) => this.host.callServerTool(...args);
  sendMessage: App["sendMessage"] = (...args) => this.host.sendMessage(...args);
  getHostContext: App["getHostContext"] = () => this.host.getHostContext();
  getHostCapabilities: App["getHostCapabilities"] = () => this.host.getHostCapabilities();
  requestDisplayMode: App["requestDisplayMode"] = (...args) => this.host.requestDisplayMode(...args);
  sendSizeChanged: App["sendSizeChanged"] = (...args) => this.host.sendSizeChanged(...args);
  openLink: App["openLink"] = (...args) => this.host.openLink(...args);
  downloadFile: App["downloadFile"] = (...args) => this.host.downloadFile(...args);

  updateContext(params: Parameters<App["updateModelContext"]>[0], isCurrent = () => true): Promise<void> {
    // Keep acknowledged host updates ordered; discard queued snapshots invalidated by a newer page/book.
    const work = this.contextWork.catch(() => {}).then(async () => {
      if (isCurrent()) await this.host.updateModelContext(params, { timeout: 15000 });
    });
    this.contextWork = work;
    return work;
  }

  async ask(context: ReadingContext | TextReadingContext, question: string) {
    // Serialize before awaiting anything. A later page change cannot alter this question.
    const text = questionMessage(context, question);
    let reply;
    try {
      reply = await this.host.sendMessage({ role: "user", content: [{ type: "text", text }] }, { timeout: 15000 });
    } catch (error) {
      // Never retry automatically: an acknowledgement can be lost after the message was accepted.
      throw new Error(`未确认消息是否送达，请先检查聊天后再决定是否重试：${error instanceof Error ? error.message : String(error)}`);
    }
    if (reply.isError) throw new Error("聊天客户端未接受消息，请重试。");
  }
}
