# 共读 · PDF 与资料阅读器

在聊天里保留原文阅读空间，让读者和 AI 对着同一段内容学习。

共读提供本地书库、PDF 阅读、扫描页 OCR，以及 arXiv 和 GitHub 资料入口。你可以翻页、选字、写下自己的问题，再把原文、版本和位置一起交给当前聊天中的 AI；回答后继续回到原文阅读。

基于 PDF.js 和 MCP Apps，派生自 MCP 官方 PDF Server 示例。阅读器本身不调用模型 API，也不需要模型密钥；回答由承载它的聊天客户端生成。

**当前状态：个人学习原型。** 主要在 Windows 本地环境开发，已完成浏览器、MCP、SQLite 和 Windows OCR 的定向验证。最新版在 Codex 原生侧栏中的完整使用及真实模型回答仍待验证，详见[验证范围](#验证范围)。

## 主要功能

| 能力 | 当前实现 |
| --- | --- |
| PDF 阅读 | 章节目录、页面缩略图、书签、页码跳转、缩放、适合宽度／整页、逐页旋转、专注阅读 |
| 阅读导航 | PageUp／PageDown、空格／Shift＋空格先滚动页内，到边缘再翻页；页面预览每组 12 页 |
| 搜索 | 搜索 PDF 原生文字层及当前窗口已识别的扫描页，跨文字片段定位实际命中位置 |
| 高亮与批注 | 高亮实际选区、撤销／重做、批注管理、表单填写及带批注 PDF 导出 |
| 本地书库 | 多选／拖入 PDF、逐文件导入队列、独立错误与进度、内容去重、继续阅读、搜索和排序 |
| 扫描页 OCR | Windows 本机按页识别；可选已安装语言及文字方向，生成可划选文字层，支持核对结果与恢复原文字层 |
| 选区共读 | 右键“向 GPT 提问”、一键解释或自由提问；问题携带固定原文、文档版本、页码／行号和 OCR 来源 |
| 读书笔记 | 选区笔记／本页笔记、当前／全部资料筛选、搜索、Markdown 导出、单条删除及返回准确引文 |
| 学习协作 | 先提问检验理解，再等待读者回答；对照原文检验自己的笔记，也可发起查源码或最小实验请求 |
| arXiv | 搜索论文、固定版本、后台下载、取消／重试、入库 |
| GitHub | 搜索、收藏／我的仓库、目录浏览，按固定提交导入 PDF、Markdown 或代码 |
| Markdown／代码 | 排版／源码切换、源文件行号、语法高亮、选区问答与位置恢复 |
| 外观与组件 | 中性、樱花、晴空、抹茶、可可五种配色；跟随客户端／浅色／深色；可选阅读进度与专注计时 |

## 快速开始

### 本机安装

需要 Node.js 24+、npm，以及用于注册连接的 Codex CLI。Bun 随开发依赖安装。宿主需要支持 MCP Apps；扫描页 OCR 另需 Windows 10/11 和对应 OCR 语言组件。

```powershell
git clone https://github.com/yuanj8699/gongdu-pdf-reader.git
cd gongdu-pdf-reader
npm ci
npm run build
.\scripts\install-plugin.ps1
```

已有本地维护目录时直接使用原目录。安装脚本注册“共读 · 本机插件”来源，并安装、启用 **共读**。在客户端「插件」页面可以查看共读；支持浏览本地来源的客户端也可在目录中选择此来源。页面仍显示旧列表时先重新进入页面，必要时保存工作后正常退出并重开客户端。

插件通过 stdio 启动现有项目的 `dist/index.js`，无须另开服务窗口。默认只授权仓库中的示例 PDF，不扫描整个磁盘。请保留本项目及其依赖、构建结果；这是本机包装，不是独立部署的云插件。机器路径只写入被 Git 忽略的 `.local-plugin/`，安装缓存由 Codex 管理。

如果只需要独立 MCP 连接，仍可使用 `scripts/install-mcp.ps1`；它显示在「MCP」标签，名称为 `pdf_reader`。完整插件附带的连接名为 `gongdu`。从旧方式迁移时，先验证插件，再移除旧注册，见 [CONNECT.md](CONNECT.md)。

客户端加载连接后，在当前聊天中说“打开共读书库”，助手会调用本地阅读器并显示书库。选择或拖入 PDF，再点击“开始阅读”。支持任务入口的客户端也可能在 **右侧＋ → PDF 阅读器** 中显示入口；菜单没有该项时可直接通过聊天打开。连接不可用或仍显示旧界面时，按 [CONNECT.md](CONNECT.md) 检查和刷新。

上传到 GitHub 只提供代码分发，不会自动部署成网页服务。

### 连接已有 PDF 文件夹

```powershell
.\scripts\install-plugin.ps1 -LibraryPath 'D:\Learning\Books'
```

书库可以扫描并批量入库，原目录只读，入库使用独立副本。重新注册时需传入全部需要保留的文件夹；不自动监控原目录或同步原文件删除。

也可只授权指定文件：

```powershell
.\scripts\install-plugin.ps1 -PdfPath 'D:\Learning\paper.pdf'
```

### GitHub 授权

公共仓库可以直接检索；收藏、我的仓库和私有资料需要本机 GitHub CLI（`gh`）授权：

```powershell
gh auth login --hostname github.com --web --git-protocol https
```

完成授权后，在“从 GitHub 找资料”里刷新账号，输入 `owner/repo` 或仓库首页链接并打开仓库。令牌无需粘贴到聊天或阅读器。文件导入固定到具体提交，不克隆整个仓库。

## 阅读与 AI 共读

### 阅读、找页与高亮

- 选中文字后右键，点击“向 GPT 提问”，即可把选中原文与出处直接发送到当前聊天。PDF、OCR 文字及 GitHub Markdown／代码都支持；聊天中可继续追问。未选择原文、输入框和阅读区外保留原有右键菜单。
- 左右方向键和翻页按钮直接换页。PageUp／PageDown、空格／Shift＋空格先移动当前页；向上跨页时落在上一页底部。输入框保留自身键盘操作。
- “导航 → 页面”展示缩略图，每组 12 页。切换预览分组不会翻正文，点击某页才跳转；收起后停止未完成的预览。
- “旋转”每次将当前页顺时针转 90°，用于调整阅读方向。角度属于当前窗口，保存 PDF 保留原文件方向。
- 选字后点击“高亮选区”，只标记本次选择的位置，重复段落不会全部被高亮；也支持 OCR 文字。
- Ctrl/Cmd＋Z 撤销。高亮和其他批注的本机缓存与 PDF 导出是两步：下载／保存后才生成带批注的 PDF。缓存写入失败时会提示下载留存。
- “专注阅读”收起学习区、OCR 和缩放工具，保留阅读导航和选区操作。可在阅读设置中调整配色与组件。

### 扫描页选字

1. 展开“文字识别”或“扫描页识字”，点击“识别本页文字”。
2. 需要时在识别设置中选择系统已安装语言和文字方向。
3. 完成后直接划选，或展开“核对识别文字”对照原页。
4. 点击解释或针对选区提问，识别文字以纯文本及出处交给聊天模型。

识别使用本机 Windows WinRT OCR，不调用聊天模型视觉识别或第三方 OCR 服务。页面图像仍经过宿主的 MCP 工具通道；这一实现不能被视为任意远程部署下的网络隔离保证。

OCR 结果始终标注“未经人工核对”。错字、公式、表格和多栏阅读顺序需要对照原页确认；“使用原文字层”可以撤回 OCR 覆盖层。识别完成不会自动发送整页 OCR 全文，显式提问或读取才会提供相应文字。

当前按页按需识别，窗口最多缓存最近 8 页。搜索包含文字层和仍在缓存中的已识别页，不自动识别整书，也不将扫描 PDF 改写成带文字层的文件。

### 写问题与学习笔记

选中原文后展开“学习与笔记”，点击“针对选区提问”。输入框打开时固定书名、位置和引用；后续翻页、切书或重新选字不会替换这一引用，折叠和专注模式保留当前草稿。

问题发送前先保存原文记录，再交给当前聊天。记录分别保留“我的问题”和“我的理解”，可以搜索与导出。发送失败时先检查聊天，再决定是否手动重试；同一问题重试复用记录，修改问题后另建记录。仅回执保存失败时，“保存笔记”只重试本机写入，不再次发送模型请求。未发送的输入草稿仅保留在当前窗口。

- **记笔记：** 有选区时保留引文，也可以直接记本页笔记；写完点击“保存笔记”。
- **返回原文：** 核对资料版本后恢复位置和页面方向，滚到保存的引文并作临时标示。同书内返回保留 OCR 缓存；没有有效引文坐标时只返回页码。
- **导出笔记：** 导出当前显示记录为 Markdown，包含出处、版本、问题、理解、OCR 标记及可见未保存草稿；导出不会替代本机保存。
- **删除记录：** 行内确认／取消，未保存草稿会明确提示一并丢弃。只删除本机学习记录，不影响原文或聊天消息。
- **检验理解：** “提问检验”要求模型先问一个问题并等你回答；“检验我的理解”将你的笔记与原文一起发送，要求区分你的判断、AI 纠正和证据不足。

多窗口新增记录会合并。同一条记录发生编辑、删除或回执保存冲突时，保留本窗口草稿并拒绝静默覆盖。消息送达只说明请求已交给宿主，模型回答和实验结果仍需在聊天中查看；阅读页数、计时和 AI 生成内容不作为掌握知识的证明。

## 数据与当前边界

| 数据 | 保存位置／生命周期 |
| --- | --- |
| 书库原件、资料身份、阅读位置和书签 | 默认 `%LOCALAPPDATA%\GongduReader`，包含本机文件与 SQLite；可用 `PDF_READER_DATA_DIR` 指定独立目录 |
| 学习记录、未导出的 PDF 批注、外观设置 | 当前客户端浏览器本地存储；清理站点数据会删除这些记录 |
| OCR 页面结果、逐页阅读角度 | 当前打开的资料／阅读窗口内存；切书或重载后清除 |
| 未发送的问题草稿、专注计时 | 当前窗口；关闭或重载不保留 |
| 导出的 Markdown／PDF | 由宿主下载或保存，需自行留存 |

- 当前是本机单用户服务，没有云端账号系统或跨设备同步。数据目录应与代码仓库、Obsidian 知识库及云盘实时同步目录分开。
- 本地 PDF 导入上限 512 MiB；GitHub PDF 上限 100 MiB，UTF-8 文本上限 1 MiB／10000 行。不导入 GitHub 符号链接、子模块或 Git LFS 实体。
- PDF 仍按单页渲染。Markdown／代码暂没有文本批注、书签界面或全文搜索，Markdown 图片不加载。
- OCR 当前仅支持 Windows 本机引擎及已安装语言；复杂书籍的准确率没有保证。
- 界面配色不改变 PDF 原稿颜色。文本字号用于 Markdown／代码，PDF 使用缩放。
- EPUB、数据库笔记同步和 Z-Library 在线连接尚未实现。
- 个人书籍、下载资料、数据库、凭据、日志、依赖和构建输出不纳入代码仓库；代码仓库仅保留源码、配置、说明和小型测试夹具。

## 开发与验证

```powershell
npm ci
npm run build
```

按改动选择现有检查，不要求每次执行全部测试：

| 命令 | 主要范围 |
| --- | --- |
| `npm test` | PDF 批注、引用上下文、服务、arXiv 和 GitHub 单元检查 |
| `npm run test:reader` | 浏览器内 PDF 读取、目录、选区、搜索、书签及实际 PDF 导出 |
| `npm run test:library` | Node／SQLite 书库与 stdio 交互 |
| `npm run test:library-ui` | 书库导入和阅读界面 |
| `npm run test:github-ui` | 仓库浏览、文本共读、消息与错误恢复 |
| `npm run test:stdio` | MCP stdio 连接与协议 |

浏览器检查可运行 `npx playwright install chromium`，或通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指向已有 Chrome／Edge。其他定向命令见 [package.json](package.json)，包括本地目录、arXiv 界面和可选联网检查。

### 验证范围

截至 2026-10-09，最新构建与现有 17 项阅读器回归已通过。近期定向检查使用真实 Chrome、PDF.js、MCP AppBridge、SQLite 和 Windows WinRT OCR，覆盖：

- 合成扫描页识别、重复文字的实际鼠标选择、纯文本发送、来源信息、取消及换页失效；清晰简体中文样例已用本机引擎识别。
- 原稿旋转、CropBox、UserUnit 和阅读角度下的选区／批注位置，以及导出后重新读取的真实 PDF 高亮。
- 缩略图分组、目录、书签、多文件导入、失败与取消。
- 自由问题的固定引用、先存后发、失败重试、问题／理解分离、导出重开及双窗口删除和迟到回执。
- Web Lock 等待期间的新笔记草稿保留、存储失败提示、笔记准确返回原文；桌面／390px、触控按钮、键盘和五种主题。
- 本地插件安装、名称与技能发现、Codex 新宿主加载 `gongdu` 工具、打开书库、读取互动界面资源和未授权文件拒绝；可用 `npm run test:plugin` 重现（先安装插件，需要本机 Codex CLI）。

这些检查采用合成材料和测试宿主；部分 GitHub API／OCR 返回值使用固定样例检验边界，不代表真实私有仓库或复杂书籍已完整验证。

**最新版在 Codex 原生侧栏里的完整操作，以及真实模型回答的内容和质量，仍待单独验证。** 测试宿主收到消息不能证明模型已经回答或读者已掌握知识。详细证据和阶段边界见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。

## 项目结构

```text
当前聊天模型 ← 原文、出处、问题 → MCP Apps 阅读界面
                                    ├─ PDF.js：页面、目录、批注、表单
                                    └─ Markdown／代码：正文、源文件行号
                                                ↕ MCP 工具
                                    本机 Node.js 服务
                                    ├─ SQLite 与书库原件
                                    ├─ Windows WinRT OCR
                                    ├─ arXiv API
                                    └─ GitHub API + 本机 CLI 授权
```

| 入口 | 职责 |
| --- | --- |
| [main.ts](main.ts)、[server.ts](server.ts) | 启动、MCP 工具、PDF 传输与阅读器交互 |
| [library.ts](library.ts)、[local-library.ts](local-library.ts) | 书库、去重、阅读状态、只读目录扫描 |
| [arxiv.ts](arxiv.ts)、[github.ts](github.ts) | 检索、固定版本和下载 |
| [src/mcp-app.ts](src/mcp-app.ts) | PDF 界面、选区、导航、搜索、宿主联动 |
| [src/page-thumbnails.ts](src/page-thumbnails.ts) | 按需缩略图与分组导航 |
| [ocr.ts](ocr.ts)、[src/ocr-panel.ts](src/ocr-panel.ts) | 本机 OCR 任务、文字层及来源 |
| [src/reading-context.ts](src/reading-context.ts)、[src/host-bridge.ts](src/host-bridge.ts) | 引用快照与宿主通信 |
| [src/study-panel.ts](src/study-panel.ts) | 问题、笔记、学习动作、导出及冲突处理 |
| [src/github-panel.ts](src/github-panel.ts)、[src/text-reader.ts](src/text-reader.ts) | 仓库导航与 Markdown／代码阅读 |
| [src/reader-settings.ts](src/reader-settings.ts)、[src/reader-widgets.ts](src/reader-widgets.ts) | 配色、设置、进度与计时 |

连接方式见 [CONNECT.md](CONNECT.md)，界面约定见 [DESIGN.md](DESIGN.md)，数据模型和实现边界见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。

## 开发历程

| 阶段 | 变化 | 代表提交 |
| --- | --- | --- |
| 2026-09-20 | 引入官方 PDF Server 示例，保留上游基线 | [18f3907](https://github.com/yuanj8699/gongdu-pdf-reader/commit/18f3907) |
| 2026-09-21～22 | 内嵌阅读、选区提问、本地书库与版本引用 | [d814e11](https://github.com/yuanj8699/gongdu-pdf-reader/commit/d814e11)、[0161b4a](https://github.com/yuanj8699/gongdu-pdf-reader/commit/0161b4a) |
| 2026-09-23～24 | arXiv、只读文件夹、缩放及 GitHub 文档／代码共读 | [8de6b27](https://github.com/yuanj8699/gongdu-pdf-reader/commit/8de6b27)、[a1ae1bc](https://github.com/yuanj8699/gongdu-pdf-reader/commit/a1ae1bc) |
| 2026-09-28～29 | 修复受限宿主操作，调整目录和正文布局，增加准确选区与学习记录 | [4c38e98](https://github.com/yuanj8699/gongdu-pdf-reader/commit/4c38e98)、[9f437b1](https://github.com/yuanj8699/gongdu-pdf-reader/commit/9f437b1) |
| 2026-10-03 起 | 本机 OCR、导入队列、五种主题、专注组件、坐标修复、扫描页搜索、引文定位和缩略图 | [9514ee3](https://github.com/yuanj8699/gongdu-pdf-reader/commit/9514ee3)、[ecdf014](https://github.com/yuanj8699/gongdu-pdf-reader/commit/ecdf014)、[ef787e0](https://github.com/yuanj8699/gongdu-pdf-reader/commit/ef787e0) |
| 最新一轮 | 高亮实际选区、修复恢复初期页码提交、单条记录删除与自由问题 | [c3a0976](https://github.com/yuanj8699/gongdu-pdf-reader/commit/c3a0976)、[353f4e7](https://github.com/yuanj8699/gongdu-pdf-reader/commit/353f4e7)、[c4f4f3f](https://github.com/yuanj8699/gongdu-pdf-reader/commit/c4f4f3f) |

开发中形成的几个判断：功能接通需要进一步验证阅读是否顺畅；宿主回执与真实回答要分开；资料版本必须固定；已有客户端／插件能力应先检查，再确定共读界面需要自行实现的部分。后续优先补足原生客户端体验和真实资料验证，再根据实际需要推进新格式与同步能力。

## 来源与许可

派生自 [modelcontextprotocol/ext-apps 的 PDF Server 示例](https://github.com/modelcontextprotocol/ext-apps/tree/6d9bdc7babf275b759225aa722cbf5510c4c6021/examples/pdf-server)，固定来源提交为 `6d9bdc7babf275b759225aa722cbf5510c4c6021`。详见 [UPSTREAM.md](UPSTREAM.md)。

仓库保留原始 [LICENSE](LICENSE)，包含上游许可过渡说明及 Apache-2.0、MIT、CC-BY-4.0 文本／说明。继承内容不能简单概括为单一 MIT 许可。
