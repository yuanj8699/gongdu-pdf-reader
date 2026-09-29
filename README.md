# 共读 · 统一 PDF 与资料阅读器

让人和 AI 对着同一份原文学习：你在侧栏阅读、翻页、选择内容，当前聊天里的 AI 根据明确的来源和位置继续解释。

项目从内嵌 PDF 阅读器起步，逐步扩展为本地书库、arXiv 论文和 GitHub 文档／代码的统一共读入口。基于 MCP 官方 PDF 示例，使用 PDF.js 和 MCP Apps。阅读器本身不调用模型 API，回答由所在聊天的模型生成。

**当前阶段：可用的个人学习原型，仍在改善阅读体验。** 已实现的功能、验证范围与未来设想在下文分别说明。主要在 Windows 本地 Codex 桌面环境开发；其他客户端需要单独验证。

## 为什么做这个项目

学习 AI 时，材料分散在 PDF 书籍、论文、GitHub README 和源代码里。阅读与提问往往是两件脱节的事：在一个窗口里看原文，在另一个窗口里复制、粘贴，再告诉 AI 自己读到哪一页、哪段话。

项目希望把这个过程变成：

> 打开资料 → 保留原文阅读界面 → 选中不理解的内容 → 直接在当前聊天中提问 → 回到原文继续读。

这带来了几个具体要求：

- **人始终能看见原文。** 目录、缩放、搜索和阅读位置都是基本阅读能力，不能只留下一个问答框。
- **问题有明确出处。** AI 应知道文档、版本、页码或代码行号，以及实际选中的文字；翻页、切书不能改写已经发出的问题。
- **不同来源共用阅读记录。** 本地文件、论文和仓库资料可以放进同一个书库，但各自的定位方式要准确保留。
- **继续使用当前聊天。** 不为阅读器另建一个需要模型密钥的问答服务，也不把“模型能检索资料”直接当成“人和模型正在共读”。

“统一”指统一资料入口、身份、阅读记录和提问方式。PDF 仍按页面阅读，Markdown 和代码使用各自的显示方式。

## 目前能做什么

| 场景 | 已实现能力 | 当前边界 |
| --- | --- | --- |
| PDF 阅读 | 目录、翻页、全文搜索、书签、批注、表单和导出 | 扫描图片 PDF 暂无 OCR |
| 缩放与滚动 | 50%–300%、适合宽度／整页、Ctrl＋滚轮缩放、普通滚轮滚动 | 桌面实际表现依赖宿主 |
| 本地书库 | 文件选择导入、授权文件夹扫描、批量入库、内容去重、继续阅读 | 不自动监控文件夹，不同步原文件删除 |
| 选区问答 | 原文与附近内容、资料版本、页码／行范围随问题发送 | 自动上下文接收不保证模型每轮都使用；显式提问携带快照 |
| arXiv | 搜索、确定论文版本、后台下载、取消／重试、入库 | 无断点续传；不同版本分别保存记录 |
| GitHub | 搜索、收藏／我的仓库、目录浏览、固定提交下载 | 只读接入，不克隆整库；私有仓库需本机授权 |
| Markdown／代码 | 排版／源码切换、行号、高亮、选区提问、阅读位置 | 暂无文本批注、书签界面和全文搜索；Markdown 图片不加载 |
| 连续阅读与外观 | 正文旁的仓库目录、窄屏收起、统一明暗／字号／目录宽度设置 | PDF 字号仍通过原有缩放工具调整 |
| 阅读与实践 | 选区查源码、做实验、保存自己的笔记，从记录返回原文件和页／行 | 请求复用当前聊天；模型回答与实际执行结果在聊天中查看，记录不自动宣称任务完成 |

书库内 PDF 的阅读位置与书签保存在本机 SQLite；文本阅读位置按源文件行保存。PDF 未导出的批注仍在浏览器存储中。所有这些都不代表跨设备同步。

学习记录与外观设置保存在当前阅读器的浏览器本地存储，清理客户端站点数据会删除这些记录。学习记录保留选中原文、资料版本和返回位置；它与 PDF 批注分开，不会自动写入 Obsidian 或云盘。

## 项目如何发展到现在

以下日期和提交对应本仓库的实际开发历史。

| 日期 | 阶段 | 当时要解决的问题与结果 | 代表提交 |
| --- | --- | --- | --- |
| 2026-09-20 | 建立基础 | 引入 MCP 官方 `examples/pdf-server`，保留上游代码和来源记录，复用已有 PDF 渲染、搜索、批注能力。 | [18f3907](https://github.com/yuanj8699/gongdu-pdf-reader/commit/18f3907) |
| 2026-09-21 | 内嵌共读 | 增加章节目录和明确的选区提问；将完整阅读器放入侧栏，并提供“＋ → PDF 阅读器”入口。重点验证“看见原文＋把实际选区传给聊天”。 | [d814e11](https://github.com/yuanj8699/gongdu-pdf-reader/commit/d814e11)、[19a246d](https://github.com/yuanj8699/gongdu-pdf-reader/commit/19a246d) |
| 2026-09-22 | 本地书库与引用 | 增加持久书库、去重、位置和书签；区分资料、版本、文件与阅读窗口，统一阅读上下文，并校验引用跳转目标。 | [0161b4a](https://github.com/yuanj8699/gongdu-pdf-reader/commit/0161b4a)、[13c30a8](https://github.com/yuanj8699/gongdu-pdf-reader/commit/13c30a8) |
| 2026-09-23 | 更多资料来源 | 接入 arXiv 搜索和版本下载；连接本地 PDF 文件夹，支持批量入库。Z-Library 在线账号链路未完成。 | [8de6b27](https://github.com/yuanj8699/gongdu-pdf-reader/commit/8de6b27)、[ce30e54](https://github.com/yuanj8699/gongdu-pdf-reader/commit/ce30e54) |
| 2026-09-24 | 基础阅读体验 | 根据“显示太小”“希望滚轮上下移动”等使用反馈，补齐可见缩放栏、适合宽度和 Ctrl＋滚轮操作。 | [1a22fd5](https://github.com/yuanj8699/gongdu-pdf-reader/commit/1a22fd5)、[a71f14c](https://github.com/yuanj8699/gongdu-pdf-reader/commit/a71f14c) |
| 2026-09-24 | GitHub 共读 | 增加仓库搜索、目录浏览和文件入库；将 GitHub 提交、文件路径和源文件行号带入 Markdown／代码问答。 | [a1ae1bc](https://github.com/yuanj8699/gongdu-pdf-reader/commit/a1ae1bc) |
| 2026-09-28 | 交互修复与反思 | 针对“打开仓库后没反应”，修复受限嵌入窗口的按钮兼容问题，补充进度、超时恢复及迟到结果处理；随后收到布局不合理的反馈，确认需要重新梳理仓库导航与正文阅读的关系。 | [4c38e98](https://github.com/yuanj8699/gongdu-pdf-reader/commit/4c38e98) |
| 2026-09-29 | 留在 Codex 内连续共读 | 复用目录形成并列阅读区，集中外观设置；PDF 选区按实际文本层边界取上下文，重复文字不再猜测首次位置；加入带原文和位置的实践／笔记记录。目标是减少切屏，编码与执行继续交给 Codex。 | [连续阅读](https://github.com/yuanj8699/gongdu-pdf-reader/commit/9f437b1)、[选区锚定](https://github.com/yuanj8699/gongdu-pdf-reader/commit/e354ca1) |

### 到这一阶段，我们学到了什么

1. **功能接通不等于阅读顺畅。** 最初账号、搜索、结果、目录和书库堆在同一区域，文件打开后又失去目录。现在将目录放到正文旁，账号与搜索留在书库；后续仍需结合真实客户端的使用反馈调整。
2. **嵌入式应用必须验证宿主行为。** 普通浏览器中可用的表单提交，在受限 iframe 中可能不触发。前端等待、工具调用超时和旧页面刷新也会影响用户感知，不能只依赖后端测试。
3. **资料身份和版本要先明确。** 同一论文或文件更新后，旧问题与书签仍应指向当时读到的版本，而不是静默跳到最新内容。
4. **应先检查已有产品能力。** Codex 已有 GitHub 插件，可承担仓库读取与分析。此前应先说明已有插件与自建共读界面的分工，再确定需要自建多少功能。自建服务目前使用 GitHub CLI 授权，尚未打通官方插件调用或凭据共用。

## 下一步方向

以下是待评估／待实现的方向，不是已交付能力或固定排期：

- **继续改善阅读体验：** 验证不同窗口尺寸下目录、正文与学习记录的实际使用，避免工具栏挤占原文。
- **厘清 GitHub 分工：** 仓库分析优先考虑现有插件；自建部分聚焦原文浏览、位置记录与选区共读，验证可行后再决定整合方式。
- **补足使用验证：** 继续检查真实客户端里的完整操作，以及真实授权仓库和较大文件场景。
- **后续格式与记录能力：** EPUB、批注持久化等按实际需求推进。Z-Library 在线连接仍需独立验证，尚未实现。

## 本机安装与使用

需要 Node.js 24+、npm；本机安装脚本还需要 Codex CLI。Bun 已作为开发依赖包含。GitHub 登录使用 GitHub CLI（`gh`）。

```powershell
git clone https://github.com/yuanj8699/gongdu-pdf-reader.git
cd gongdu-pdf-reader
npm ci
npm run build
.\scripts\install-mcp.ps1
```

本仓库现已公开，可直接查看和克隆。已有本地维护目录的开发者直接使用原目录，不必另建一份副本。

在客户端重新连接 MCP 后，打开 **右侧＋ → PDF 阅读器 → 我的书库**。选择 PDF 导入，点击“开始阅读”，选中原文后点击“解释选中内容”。默认安装只注册项目自带的示例 PDF，不自动授权整个磁盘。

连接本地 PDF 文件夹：

```powershell
.\scripts\install-mcp.ps1 -LibraryPath 'D:\Learning\Books'
```

刷新连接后，在书库里扫描并批量入库；原文件只读。每次重新注册时，请传入全部需要保留的文件夹。

GitHub 收藏／私有仓库授权：

```powershell
gh auth login --hostname github.com --web --git-protocol https
```

完成浏览器授权后，在“从 GitHub 找资料”中点击“刷新账号”。输入 `owner/repo` 或仓库首页链接，点击“打开仓库”，然后点文件阅读。令牌不需要粘贴到聊天或阅读器页面。

更完整的注册、客户端刷新、侧栏和远程连接说明见 [CONNECT.md](CONNECT.md)。ChatGPT 网页部署是另一条连接路径，本仓库上传到 GitHub 不会自动使其上线。

## 架构与代码入口

```text
当前聊天模型 ← 选区、上下文、问题 → MCP Apps 阅读界面
                                    ├─ PDF.js：PDF、目录、批注
                                    └─ Markdown／代码：正文、源文件行号
                                                ↕ MCP 工具
                                    本机 Node.js 服务
                                    ├─ SQLite：资料身份、阅读记录、下载任务
                                    ├─ 本机文件：不可覆盖的书库原件
                                    ├─ arXiv API
                                    └─ GitHub API + 本机 CLI 授权
```

| 文件 | 职责 |
| --- | --- |
| [main.ts](main.ts)、[server.ts](server.ts) | 服务启动、MCP 工具、PDF 数据传输与阅读器交互 |
| [library.ts](library.ts)、[local-library.ts](local-library.ts) | 持久书库、内容去重、阅读状态、授权目录扫描 |
| [arxiv.ts](arxiv.ts)、[github.ts](github.ts) | 来源检索、版本固定和文件获取 |
| [src/mcp-app.ts](src/mcp-app.ts) | PDF 阅读界面、选区、状态切换和宿主联动 |
| [src/reading-context.ts](src/reading-context.ts)、[src/host-bridge.ts](src/host-bridge.ts) | 统一引用上下文与宿主通信 |
| [src/github-panel.ts](src/github-panel.ts)、[src/text-reader.ts](src/text-reader.ts) | 仓库浏览与 Markdown／代码阅读 |
| [src/reader-workspace.ts](src/reader-workspace.ts)、[src/reader-settings.ts](src/reader-settings.ts)、[DESIGN.md](DESIGN.md) | 连续阅读布局、统一设置与界面规范 |
| [src/study-panel.ts](src/study-panel.ts)、[src/selection-context.ts](src/selection-context.ts) | 原文实践记录、笔记与实际选区边界 |

数据模型、各阶段的行为约束和详细验证范围见 [实现说明](docs/IMPLEMENTATION.md)。

## 数据存放与已知限制

- 默认书库在 `%LOCALAPPDATA%\GongduReader`，包含 SQLite、原件、导入暂存和导出文件；可用 `PDF_READER_DATA_DIR` 指定其他独立目录。
- 代码仓库只保存源码、配置、说明和小型测试夹具。个人书籍、下载资料、数据库、令牌、日志、依赖及构建输出不上传。
- 本地 PDF 导入上限为 512 MB；GitHub PDF 为 100 MB，UTF-8 文本为 1 MB／10000 行；不读取 GitHub 符号链接、子模块和 Git LFS 实体。
- 目前按本机单用户服务设计，没有云端账号系统或跨设备同步。数据目录不应放入知识笔记仓库或云盘实时同步目录。
- 自动上下文同步、显式选区提问、后端读取状态是不同链路；宿主收到上下文更新不代表模型一定使用，发送失败也不能显示为成功。
- GitHub 目录独立加载，不阻塞已入库 PDF 正文；30 秒超时提示用于恢复交互，并不能替代对具体宿主故障的诊断。

## 开发与验证

```powershell
npm run build
npm test
npm run test:library
npm run test:library-ui
npm run test:github-ui
```

浏览器检查需先运行 `npx playwright install chromium`，或通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指向已有 Chromium／Edge。更多定向检查包括 `test:stdio`、`test:reader`、`test:local-library`、`test:arxiv-ui` 和可选的 `test:arxiv-live`；按改动选择即可。

截至 2026-09-28，已有构建、后端单测、真实 Node/SQLite 书库检查，以及使用 MCP AppBridge 的浏览器交互回归。GitHub 浏览器回归使用固定 API 样例，包含按钮／回车、无表单权限的沙箱、错误、超时及迟到结果；不把测试宿主收到消息当作真实模型已经回答。

真实联网记录包括 arXiv 指定版本下载与重启恢复，以及 GitHub 已登录账号、`earendil-works/pi` 提交解析和目录读取。实际阅读上下文也已回传该仓库的 README。真实私有仓库下载、跨设备及不同宿主的完整体验尚不能据此认定已验证。上游仍有两项既有跳过：macOS kqueue 专用检查、未知窗口的长轮询检查。

## 来源与许可说明

项目派生自 [modelcontextprotocol/ext-apps 的 PDF Server 示例](https://github.com/modelcontextprotocol/ext-apps/tree/6d9bdc7babf275b759225aa722cbf5510c4c6021/examples/pdf-server)，固定来源提交为 `6d9bdc7babf275b759225aa722cbf5510c4c6021`。初始 Git 提交保留引入基线，后续提交记录本项目的扩展。详见 [UPSTREAM.md](UPSTREAM.md)。

仓库保留原始 [LICENSE](LICENSE)，其中含上游许可过渡说明及 Apache-2.0、MIT、CC-BY-4.0 文本／说明；不能将整个继承内容简单概括为单一 MIT 许可。本次文档整理不改写上游许可。
