# 在本机 ChatGPT / Codex 中使用 PDF 阅读器

本项目优先连接当前桌面客户端的本地 MCP host。服务通过 stdio 启动，PDF
数据通过 MCP 传给内嵌阅读器；这条路径不需要 OpenAI API key、公开域名或隧道。
ChatGPT 网页的远程连接是另一条路径，见本文最后一节。

## 安装完整本地插件

在正式维护目录中构建，然后安装：

```powershell
npm ci
npm run build
.\scripts\install-plugin.ps1
codex plugin list --marketplace gongdu-local --json
```

安装后的插件名为 **共读**，本地来源为 **共读 · 本机插件**，技术标识为
`gongdu@gongdu-local`。CLI 返回 `installed: true` 和 `enabled: true` 后，可在客户端
「插件」页面查找。列表仍旧时先重新进入该页面；必要时保存其他工作后正常退出并重开客户端，
不要强制结束后台进程。

`plugins/gongdu/` 保存版本化的插件清单、图标与共读技能；脚本生成忽略的
`.local-plugin/` 市场目录及本机 MCP 配置，再由 Codex 安装。阅读器仍使用本项目
的 `dist/index.js` 和原来的 `%LOCALAPPDATA%\GongduReader` 书库，不复制代码或书库。
请保留项目目录、Node.js、依赖与构建结果。项目移动或授权路径改变后重新执行安装脚本；
更新插件清单或技能时同步修改两个清单的版本号，再重装，不手工编辑插件缓存。

脚本支持 `-PdfPath`、`-LibraryPath` 和 `-WhatIf`，文件边界与下面的独立 MCP 方式一致；
重新安装时需要传入全部希望保留的授权路径。默认仅授权示例 PDF。
完整插件使用 `gongdu` 连接名，旧的独立注册使用 `pdf_reader`。迁移后先验证：

```powershell
npm run test:plugin
```

此检查会启动临时 Codex app-server，创建仅在内存中的验证会话，确认插件清单、MCP 工具、
书库调用、阅读界面资源和未授权文件拒绝；不调用聊天模型，也不证明桌面插件页已刷新。
检查成功且旧连接只服务共读时，可移除旧注册以避免重复工具：

```powershell
codex mcp remove pdf_reader
```

这只移除连接配置，不删除书库或笔记。如需恢复旧连接，使用下方的 `install-mcp.ps1`。
加载插件后，在聊天中说“打开共读书库”，由助手调用 `gongdu` 的 `open_library`。

## 仅安装独立 MCP 连接

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

`-PdfPath` 只接受已经存在的 `.pdf` 文件，不接受目录。再次执行会更新同名连接的文件
列表。可加 `-WhatIf` 预览注册动作，或用 `-ServerName` 选择另一个连接名。

连接本地文件夹时使用独立的只读选项，可和 `-PdfPath` 同时使用：

```powershell
.\scripts\install-mcp.ps1 -LibraryPath 'D:\Learning\Books'
```

它注册 `--library-dir=<绝对路径>`，不会授权原目录的写入。“我的书库”中可扫描、
批量入库和重新扫描新下载的 PDF；入库后使用独立副本和持久阅读记录。
每次注册请传入全部需要保留的文件夹。直接将目录作为裸 CLI 参数是旧的读写授权方式，
不应用于只读本地书库。账号登录、在线搜索和下载不属于此文件夹连接功能。

检查保存的配置：

```powershell
codex mcp get pdf_reader --json
```

这只证明配置已保存；还需要下面的实际阅读测试。

## 让当前任务加载新配置

Codex 官方 app-server 提供 `config/mcpServer/reload`：重读磁盘配置，并为已加载
任务排队刷新 MCP 工具。它可以保留当前任务，不要求新建任务。调用后，需要等
刷新完成，并在后续模型轮次核对 `gongdu`（完整插件）或 `pdf_reader`（独立连接）
工具确实出现在工具列表。

当前 Windows 桌面版本（26.915.4065）通过 stdio 连接后台，不使用
`codex app-server proxy` 所需的控制 socket。因此不能把从终端发送 reload
当成已经可用的办法，也不能声称 `codex mcp add` 已让本轮工具自动刷新。
不要为此结束其他任务或强制终止后台进程。

如果当前客户端提供 MCP 重新连接/刷新操作，先使用该操作，在同一任务继续。
若没有可用的刷新入口，等其他任务完成并保存工作后，右键 Windows 系统托盘
中的 Codex / ChatGPT 图标，选择菜单最后的“退出 / Quit”，再重新打开并回到
原任务。当前版本的该菜单调用正常退出；只关闭窗口可能保留旧后台和旧 MCP 连接。

新任务或子代理可能启动独立 MCP 进程，不能据此判断原任务的连接已刷新。
刷新后关闭旧阅读器标签，再从“＋ → PDF 阅读器”打开，以免继续使用旧版已加载页面。
刷新后应核对实际资源包含 `data:` / `blob:` worker 权限，且
`get_viewer_state` 返回 `loaded: true`、`error: null` 和正确页数，再继续下面
的实际阅读测试。

## 首次阅读验收

在启用连接的任务中发出：

> 用共读打开示例 PDF，显示内嵌阅读器。

模型应先发现 PDF，再调用 `display_pdf`。工具卡应显示真正的阅读器，展开后
可翻页、缩放、搜索和选中文字。只返回文本或下载链接不算内嵌阅读成功。

按顺序检查：

1. 打开目录，点击第二页的“第一节 短词”，确认正文与页码都改变。
2. 选中“章”，右键点击“向 GPT 提问”（也可点击“解释选中内容”）；当前聊天应收到一条含文档标识、第二页和这个字的消息。
3. 翻到第三页，旧选区应清除；选中“学习”再次提问，不应沿用“章”。
4. 选中文字后直接在聊天里问“我现在选中了什么”，模型可调用
   `interact` 的 `get_viewer_state`，并核对返回的页码、选区和附近文本。
5. 保存一条书签和批注，重新打开同一文档检查恢复；导出的 PDF 应保留批注。

`interact` 需要原来的阅读器保持打开并处理命令。阅读器关闭时，不能把无响应
误报成已经读取到最新选区。自动上下文更新和按钮发消息也应分别验证。

阅读位置和书签属于本机阅读状态，不代表已经实现跨设备同步。

## 在右侧栏保留完整阅读器与目录

连接加载后，在当前聊天中说“打开共读书库”，由助手调用 `open_library`。它显示持久书库，
选择本地 PDF 导入后，点击“开始阅读”或“继续阅读”。新文件由文件选择器分块传入，
不必为每本书重新注册 MCP。原有按路径调用仍只允许明确授权的文件。

`open_library` 声明了 MCP 任务入口；支持该入口的客户端可能在右侧 **＋ → PDF 阅读器**
菜单中显示它。菜单没有该项不等于服务未安装：完整插件检查
`codex plugin list --marketplace gongdu-local --json`；独立连接检查
`codex mcp get pdf_reader --json`，再通过聊天直接打开书库。打开书库会创建新的阅读器实例，并恢复本机资料，
不会接管聊天中已经打开的文档。若应用显示在聊天里，可用下面的展开操作进入侧栏。
连接不可用或显示旧界面时，再按“让当前任务加载新配置”检查刷新；直接打开
`mcp-app.html` 文件不能替代已连接宿主的阅读器。

已有聊天内的阅读器可按下面的方式移到侧栏，继续使用当前文档与阅读状态。

当前 Codex 桌面客户端会把 MCP App 的 `fullscreen` 模式放进右侧栏，并移动
原来的阅读器界面，保留文档、章节目录和选区提问。点击聊天阅读器右上角的
“展开阅读器”（旧版为四角展开图标），或在阅读器内按 Ctrl+Enter，即可进入。
较窄的侧栏中，点击“目录”展开章节树；选完章节后目录会收起以留出正文空间。

模型应沿用 `display_pdf` 返回的 `viewUUID`，调用：

```json
{"viewUUID":"原阅读器的 UUID","action":"display_mode","mode":"fullscreen"}
```

返回的 `displayMode` 为 `fullscreen` 才表示切换得到确认。传 `inline` 可回到
聊天内显示。此命令需要客户端已加载本次更新后的 MCP 工具和阅读器页面。

`open_in_codex` 的文件预览是另一种界面：已实测可用 PDF 选区批注提问，但它
不提供本项目的章节树。用户要求“侧栏阅读器与目录”时应使用上述展开操作，
不能用打开 PDF 文件预览来代替。

## 书库验收

也可让模型调用 `open_library` 打开书库。按路径入库使用 `library_import_pdf`，仅接受
现有授权清单内的本地文件；`library_list` 返回 `assetId`，再用 `display_pdf({assetId})`
打开确定的原件。托管文件使用不含凭据的 `library://<assetId>` 读取标识。

选择一份 PDF 导入 → 翻页 → 添加书签 → 等待“已保存到书库” → 关闭并重启连接 →
从书库继续阅读。页码与书签应保留。重复导入同一文件应只有一条资料。
当前原件和数据库位于 `%LOCALAPPDATA%\GongduReader`，旧浏览器书签在能够确定指纹
对应关系时迁移。未导出的批注仍保存在浏览器，应单独导出重要批注。

## 直接调试 MCP 服务

新版书库已包含 arXiv 搜索。连接刷新后，在“从 arXiv 找论文”中输入关键词或论文编号，
选择版本并下载；任务完成后点“打开论文”。模型也可先 `arxiv_search` / `arxiv_resolve`，
再用明确含 `vN` 的编号调用 `arxiv_download`。工具返回排队任务不表示入库完成，
界面会显示进度；完成后使用返回的 `assetId` 打开。

下载只在本机服务运行时继续，关闭阅读面板不取消任务。重启后中断任务可以手动重新下载，
已完成资料仍可离线阅读。接入不需要额外填写 arXiv 账号。

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
