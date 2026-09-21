# 共读 · PDF 阅读器

把 PDF 阅读器嵌入支持 MCP Apps 的聊天客户端。基于 MCP 官方 PDF 示例，代码与依赖固定在这个 Git 项目中。

## 已实现

- PDF.js 渲染、翻页、缩放、全文搜索、内嵌和全屏。
- 左侧章节树、章节跳转、当前章节提示；无目录时显示说明。
- 选中文字后点击“解释选中内容”，发送文档、页码、原文与附近段落给当前聊天。
- 自动同步当前页/选区，模型也可用 `get_viewer_state` 主动读取。
- 本机书签、阅读位置和批注按文档保存，重新打开仍可恢复。
- 保留官方批注、表单填写、带批注 PDF 导出与明确的保存操作。

阅读器本身不运行语言模型。解释由所在聊天的模型给出；普通浏览器测试宿主只验证消息，不生成假回答。

## 本机安装与使用

要求 Node.js 22 或更新版本，npm。Bun 已列入开发依赖，无须全局安装。

```powershell
npm ci
npm run build
.\scripts\install-mcp.ps1
```

默认仅注册项目自带的三页示例 PDF。加载自己的资料：

```powershell
.\scripts\install-mcp.ps1 -PdfPath 'D:\Learning\paper.pdf', 'D:\Learning\book.pdf'
```

连接名为 `pdf_reader`。让客户端重新加载 MCP 配置后，在聊天中说：

> 用 pdf_reader 打开示例 PDF。

选中文字后点击“解释选中内容”，或直接在聊天中问“我现在选中的内容是什么意思”。模型应继续使用原来的阅读视图，避免重复创建阅读器。

公开 HTTPS PDF 可直接让模型打开。原始学习资料继续存放在原位置；不需要复制进 AI Learning OS。

[详细接入说明](CONNECT.md) 包含当前桌面客户端、ChatGPT 网页、刷新及故障排查。`/mcp` 是协议端点，不是独立网页。

## 验证

```powershell
npm run build
npm test
node scripts/test-mcp-stdio.mjs
npx playwright install chromium
npm run test:reader
```

已有 Chromium 时可设置 `PLAYWRIGHT_EXECUTABLE_PATH`，再运行 `test:reader`。

浏览器用例使用真实 PDF、PDF.js、MCP 服务和 SDK AppBridge，检查目录跳转、鼠标选择中文单字/双字、发送/拒收消息、清空选区、翻页、搜索、书签与阅读位置、跨阅读实例恢复批注，以及导出后重新解析高亮对象。聊天客户端的实际内嵌与模型回答要另外联测。

上游单测中两项既有跳过：仅 macOS 可运行的 kqueue 原子替换测试，以及耗时的未知视图长轮询测试。

## 数据与范围

- 本地安装脚本只接受明确指定的 PDF 文件；不会自动开放客户端的整个工作目录。
- 书签、阅读位置、未导出的批注保存在客户端浏览器存储，暂不跨设备同步。重要批注应导出到 PDF。
- 扫描图片 PDF 可显示，但没有文字层时不能直接选词；此版不包含 OCR。
- 本地 HTTP 调试只监听 `127.0.0.1`，通过单个常驻进程运行。
- 密钥、日志、依赖和测试中间产物不纳入 Git。源码与测试夹具纳入 Git。

## 来源

上游 MIT 许可证见 [LICENSE](LICENSE)，来源提交见 [UPSTREAM.md](UPSTREAM.md)。初始 Git 提交保留官方示例，后续提交记录本项目改动。
