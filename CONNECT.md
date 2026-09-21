# 在本机 ChatGPT / Codex 中使用 PDF 阅读器

本项目优先连接当前桌面客户端的本地 MCP host。服务通过 stdio 启动，PDF
数据通过 MCP 传给内嵌阅读器；这条路径不需要 OpenAI API key、公开域名或隧道。
ChatGPT 网页的远程连接是另一条路径，见本文最后一节。

## 安装本地连接

在项目目录执行一次构建：

```powershell
npm ci
npm run build
```

注册示例 PDF：

```powershell
.\scripts\install-mcp.ps1
```

脚本调用 `codex mcp add pdf_reader`，保存本机 Node 和 `dist/index.js` 的绝对
路径，默认只授权 `tests/fixtures/reader-smoke.pdf`。它不会扫描 Documents
或 AI Learning OS，也不启用客户端目录 roots。Codex 连接时会启动服务，无须
另外运行 `start-reader.ps1`。

使用自己的 PDF 时，明确指定文件，可同时给出多个文件：

```powershell
.\scripts\install-mcp.ps1 -PdfPath 'D:\Learning\paper.pdf'
.\scripts\install-mcp.ps1 -PdfPath 'D:\Learning\paper.pdf', 'D:\Learning\book.pdf'
```

脚本只接受已经存在的 `.pdf` 文件，不接受目录。再次执行会更新同名连接的文件
列表。可加 `-WhatIf` 预览注册动作，或用 `-ServerName` 选择另一个连接名。

检查保存的配置：

```powershell
codex mcp get pdf_reader --json
```

这只证明配置已保存；还需要下面的实际阅读测试。

## 让当前任务加载新配置

Codex 官方 app-server 提供 `config/mcpServer/reload`：重读磁盘配置，并为已加载
任务排队刷新 MCP 工具。它可以保留当前任务，不要求新建任务。调用后，需要等
刷新完成，并在后续模型轮次核对 `pdf_reader` 工具确实出现在工具列表。

当前 Windows 桌面环境的核验结果：`codex app-server proxy` 默认控制 socket
无法连接，因此不能把从终端发送 reload 当成已经可用的办法，也不能声称
`codex mcp add` 已让本轮工具自动刷新。不要为此结束其他任务或强制终止后台进程。

如果当前客户端提供 MCP 重新连接/刷新操作，先使用该操作，在同一任务继续。
若没有可用的刷新入口，保存工作后正常退出并重新打开桌面客户端，再回到原任务。
重启后的验收依据仍是工具发现与下面的实际调用，不是“应用已重启”。

## 首次阅读验收

在启用连接的任务中发出：

> 用 pdf_reader 打开示例 PDF，显示内嵌阅读器。

模型应先发现 PDF，再调用 `display_pdf`。工具卡应显示真正的阅读器，展开后
可翻页、缩放、搜索和选中文字。只返回文本或下载链接不算内嵌阅读成功。

按顺序检查：

1. 打开目录，点击第二页的“第一节 短词”，确认正文与页码都改变。
2. 选中“章”，点击“解释选中内容”；发出的消息应含文档标识、第二页和这个字。
3. 翻到第三页，旧选区应清除；选中“学习”再次提问，不应沿用“章”。
4. 选中文字后直接在聊天里问“我现在选中了什么”，模型可调用
   `interact` 的 `get_viewer_state`，并核对返回的页码、选区和附近文本。
5. 保存一条书签和批注，重新打开同一文档检查恢复；导出的 PDF 应保留批注。

`interact` 需要原来的阅读器保持打开并处理命令。阅读器关闭时，不能把无响应
误报成已经读取到最新选区。自动上下文更新和按钮发消息也应分别验证。

阅读位置和书签属于本机阅读状态，不代表已经实现跨设备同步。

## 直接调试 MCP 服务

需要 MCP Inspector 或独立测试 host 时，可运行：

```powershell
.\scripts\start-reader.ps1 -Port 3001
```

它在前台运行单个 HTTP 服务，端点是 `http://127.0.0.1:3001/mcp`，启用
`interact`。按 Ctrl+C 结束。`/mcp` 是协议端点，不是可直接打开的阅读网页。
不要把这个 HTTP 调试进程与本地 stdio 连接混用来验证同一个阅读器会话。

`-Stdio` 可直接启动 stdio 服务用于协议调试；标准输出专供 MCP 消息。

## ChatGPT 网页接入的边界

本地 stdio 配置不等于已经在 ChatGPT 网页安装同一个连接。网页开发者模式需要
可达的 HTTPS MCP 端点或 Secure MCP Tunnel，并受账号/工作区权限限制。
Secure MCP Tunnel 还要求 tunnel_id、运行凭据、相应 Platform 权限和工作区关联。
本项目的本机安装脚本不配置这些服务，不以网页接入作为本地配置已完成的证据。

官方参考：

- [Codex 本地 MCP 配置](https://developers.openai.com/codex/mcp)
- [MCP Apps UI 与模型上下文](https://developers.openai.com/plugins/build/chatgpt-ui)
- [app-server 的 MCP reload 与工具调用](https://learn.chatgpt.com/docs/app-server#api-overview)
- [ChatGPT 网页连接与测试](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Secure MCP Tunnel 的前提](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
