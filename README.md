# Pi Desktop

Pi Desktop 是 [pi 编程智能体](https://github.com/badlogic/pi-mono) 的桌面 GUI 应用，基于 **Electron** 将 Next.js Web 界面封装为原生桌面体验。通过 IPC（进程间通信）取代 HTTP/SSE，实现更低延迟的实时交互。同时保留独立 Web 服务模式（`pi-web`），可脱离 Electron 在浏览器中运行。

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（Next.js 热重载 + Electron 窗口）
npm run dev

# 仅启动 Web 服务（不依赖 Electron）
npm start          # 生产模式，端口 30141
npx pi-web         # 通过 bin 命令启动
```

## 架构

```
渲染进程 (Chromium)                        主进程 (Node.js)
     │                                           │
     ├─ window.electron.invoke('get-sessions') ──▶ ipcMain.handle 读取 ~/.pi/agent/sessions/
     ├─ window.electron.invoke('agent-new') ─────▶ startRpcSession() → AgentSession 引擎
     ├─ window.electron.on('agent-event-*') ◀──── session.onEvent() 事件推送
     ├─ pi-file:///Users/.../image.png ──────────▶ protocol.handle('pi-file') 自定义协议
     ├─ window.electron.invoke('list-dir') ──────▶ fs.promises.readdir → JSON
     └─ window.electron.invoke('read-file') ─────▶ fs.promises.readFile → content
```

**与原有 Web 架构的对比：**

| 维度 | Web 模式 | Electron Desktop |
| :--- | :--- | :--- |
| 基础通信 | `fetch()` HTTP 请求 | `ipcRenderer.invoke()` IPC |
| 流式事件 | `EventSource` (SSE) | `ipcRenderer.on` 事件监听 |
| 文件读取 | `GET /api/files/*` | `pi-file://` 自定义协议 |
| 文件列表 | HTTP 请求 | `list-dir` IPC |
| 文件监听 | SSE 事件推送 | `fs.watch` + IPC 事件 |
| 会话控制 | `POST /api/agent/[id]` | `agent-send` IPC |
| 会话事件 | SSE `/api/agent/[id]/events` | `agent-subscribe` + IPC 事件 |
| 认证授权 | SSE 推送 + POST 回传 | 主进程主动派发 IPC 事件 + invoke 回传 |

## 功能

- **会话浏览器** — 按工作目录分组展示所有 pi 会话，树形视图支持父子分支关系
- **实时对话** — IPC 事件流替代 SSE，与智能体实时交互，支持流式输出
- **会话分叉 (Fork)** — 从任意用户消息创建独立的新 `.jsonl` 会话文件
- **会话内分支 (Branch)** — 回退到任意节点继续对话，在同一会话文件内创建分支
- **分支导航器** — 可视化切换同一会话内的各个分支
- **模型切换** — 对话中途随时切换模型，支持思考等级调整（thinking level）
- **工具面板** — 控制智能体可使用的工具（预设：无 / 默认 / 全部）
- **会话压缩** — 对长会话进行自动 / 手动摘要，节省上下文窗口
- **文件浏览器** — 侧边栏内置文件树，支持文本 / 图片 / 音频 / PDF / DOCX 预览
- **多 Tab 标签页** — 同时打开多个会话和文件
- **模型配置** — 内置 Models 配置面板，可视化编辑 `~/.pi/agent/models.json`、管理 API Key
- **技能商店** — 浏览、搜索、安装 pi skills
- **OAuth 登录** — 支持 GitHub Copilot、ChatGPT Plus/Pro 等 OAuth 提供商授权
- **会话导出** — 将对话导出为 HTML 文件
- **拖拽上传** — 支持拖拽文件到聊天区域自动上传
- **暗色 / 亮色主题** — 自动跟随系统或手动切换

## 项目结构

```
pi-desktop/
├── main.js                          # Electron 主进程入口
├── preload.js                       # Preload 脚本：通过 contextBridge 暴露 electron API
├── next.config.ts                   # Next.js 配置（output: 'export' 静态导出）
├── package.json                     # 依赖与 electron-builder 配置
├── bin/
│   └── pi-web.js                    # CLI 入口：启动 Next.js 生产服务
│
├── src/
│   ├── app/                         # Next.js 页面路由
│   │   ├── globals.css              # 全局样式 + CSS 变量
│   │   ├── layout.tsx               # 根布局（字体、Katex、暗色主题注入）
│   │   ├── page.tsx                 # 首页（挂载 AppShell）
│   │   └── favicon.ico
│   │
│   ├── components/                  # React UI 组件
│   │   ├── AppShell.tsx             # 顶层布局 + URL 状态同步 + Tab 管理
│   │   ├── SessionSidebar.tsx       # 会话树 + 文件浏览器
│   │   ├── ChatWindow.tsx           # 消息列表 + 流式渲染 + fork/navigate 逻辑
│   │   ├── ChatInput.tsx            # 输入栏 + 模型 / 思考 / 工具 / 压缩控件
│   │   ├── MessageView.tsx          # 单条消息渲染（user/assistant/toolCall/toolResult）
│   │   ├── MarkdownBody.tsx         # Markdown 渲染（react-markdown + 数学公式 + 代码高亮）
│   │   ├── BranchNavigator.tsx      # 会话内分支切换器
│   │   ├── ChatMinimap.tsx          # 消息列表滚动缩略图
│   │   ├── TabBar.tsx               # Tab 标签栏（Chat + 已打开文件）
│   │   ├── FileExplorer.tsx         # 侧边栏文件树
│   │   ├── FileViewer.tsx           # 文件内容查看器（文本/图片/音频/PDF/DOCX）
│   │   ├── FileIcons.tsx            # 文件类型图标映射
│   │   ├── ToolPanel.tsx            # 工具预设管理（PRESET_NONE/DEFAULT/FULL）
│   │   ├── ModelsConfig.tsx         # 模型配置弹窗
│   │   ├── SkillsConfig.tsx         # 技能商店面板
│   │   └── SessionStatsBar.tsx      # 会话统计栏（Token 用量 / 费用）
│   │
│   ├── hooks/                       # React Hooks
│   │   ├── useAgentSession.ts       # Agent 会话状态管理 + SSE/IPC 事件订阅
│   │   ├── useAudio.ts              # 音频播放（TTS 语音输出）
│   │   ├── useDragDrop.ts           # 拖拽文件上传
│   │   └── useTheme.ts              # 暗色 / 亮色主题切换
│   │
│   ├── lib/                         # 业务逻辑库
│   │   ├── rpc-manager.ts           # AgentSession 包装器 + 全局注册表 + 空闲回收
│   │   ├── session-reader.ts        # .jsonl 会话文件解析 + 模型列表读取
│   │   ├── agent-client.ts          # 客户端 IPC 命令发送封装
│   │   ├── normalize.ts             # toolCall 字段名规范化（file format → internal types）
│   │   ├── file-paths.ts            # 文件路径处理工具（编码、相对路径、跨平台）
│   │   ├── markdown.ts              # Markdown 渲染工具
│   │   ├── npx.ts                   # npx 命令行工具封装
│   │   ├── types.ts                 # 共享 TypeScript 类型定义
│   │   └── pi-types.ts              # Pi 引擎类型定义
│   │
│   ├── main/                        # Electron 主进程
│   │   ├── ipc-handlers.js          # Agent / Session / Models / Auth / Skills IPC 处理器
│   │   ├── ipc-handlers-files.js    # 文件系统 IPC 处理器 + pi-file/app 协议
│   │   └── rpc-manager.js           # AgentSession 生命周期管理（Node.js 侧）
│   │
│   └── types/
│       └── electron.d.ts            # window.electron 全局类型声明
│
├── public/                          # Next.js 公共静态资源
└── docs/
    └── SKILL_find_skills.md         # 技能商店 API 说明
```

## 关键设计决策

### AgentSession 生命周期
- 每个 session id 对应一个 `AgentSessionWrapper`，存储在 `globalThis.__piSessions` 中
- 使用 `globalThis` 而非模块级 Map，因为 Next.js 热重载会重置模块变量
- 空闲超时：10 分钟自动销毁。并发 `startRpcSession()` 通过 `globalThis.__piStartLocks` 共享 Promise

### Fork 必须立即销毁 Wrapper
`AgentSession.fork()` 会**原地修改** wrapper 的 `sessionId` 为新的会话 id。fork 后若不立即 `destroy()`，下一次请求会拿到已 fork 的状态，导致后续 fork 产生错误的 `parentSession` 链。

### 两种分支，不要混淆
- **Fork**（用户消息上的 Fork 按钮）：创建新的独立 `.jsonl` 文件，通过 header 中的 `parentSession` 字段在侧边栏展示父子关系
- **会话内分支**（Continue 按钮 / BranchNavigator）：在同一文件内调用 `navigate_tree`，多个条目共享 `parentId`。切换时通过 `/api/sessions/[id]/context?leafId=` 获取对应上下文

### ToolCall 字段规范化
Pi 存储 toolCall 为 `{type:"toolCall", id, name, arguments}`，但内部类型 `ToolCallContent` 使用 `{toolCallId, toolName, input}`。`normalize.ts` 中的 `normalizeToolCalls()` 负责统一处理此差异，在文件读取和流式事件中均被调用。

### 工具禁用时的系统提示词
当 `toolNames = []`（完全禁用工具）时，rpc-manager 会通过 `system-prompt-off.ts` 注入最小化系统提示词，确保智能体在无工具模式下仍正常工作。

### SSE 断线重连
页面刷新时，若检测到 `state.isStreaming === true`，自动重连 SSE。`thinkingLevel` 和 `isCompacting` 状态也会同步恢复。

### 会话压缩事件
新旧 pi 版本分别使用 `compaction_start/end` 和 `auto_compaction_start/end` 事件名，前端兼容两组事件保持 `isCompacting` 状态同步。手动压缩为阻塞式 POST，按钮在请求返回前保持禁用。

### 孤立会话
首行无法解析为有效 header 的会话标记为 `orphaned: true`，侧边栏显示 "incomplete" 徽章且不可点击。

## 会话文件格式

会话存储在 `~/.pi/agent/sessions/<编码cwd>/<时间戳>_<uuid>.jsonl`：

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`parentSession` 仅用于侧边栏显示父子关系，不影响对话内容，因此可以安全地全量重写会话文件。

## 打包

```bash
npm run build    # 依次执行 next build + electron-builder
```

产出物位于 `dist/` 目录：

- macOS: `Pi Desktop-*.dmg`
- Windows: `Pi Desktop Setup *.exe`

## 环境变量

| 变量 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `PI_CODING_AGENT_DIR` | 智能体数据目录 | `~/.pi/agent` |
| `SKILLS_API_URL` | 技能商店 API 地址 | `https://skills.sh` |

## 技术栈

| 层级 | 技术 |
| :--- | :--- |
| 前端框架 | React 19, Next.js 16（静态导出） |
| 桌面框架 | Electron 42 |
| 样式 | Tailwind CSS 4 |
| Agent 引擎 | `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` |
| Markdown | react-markdown, remark-gfm, remark-math, rehype-katex |
| 代码高亮 | react-syntax-highlighter |
| 图表 | Mermaid |
| 文档处理 | mammoth (DOCX) |
| 打包 | electron-builder |

## 许可

MIT
