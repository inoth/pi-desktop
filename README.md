# Pi Desktop

**Pi Desktop** 是 [pi 编程智能体](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-coding-agent`）的桌面 GUI 应用，基于 **Electron 42** 将 React 界面封装为原生桌面体验。

所有 Agent 通信都通过 Electron IPC（进程间通信）进行，无需 HTTP/SSE。同时保留独立 Web 服务模式（`pi-web` 命令），可在浏览器中运行。

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（Next.js 热重载 + Electron 窗口）
npm run dev

# 仅启动 Web 服务（浏览器访问）
npx pi-web                # 默认端口 30141
npx pi-web --port 8080    # 自定义端口

# 构建分发包
npm run build
```

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Renderer Process (Chromium / Next.js 16)                      │
│                                                                 │
│  ┌─────────────────────┐   ┌────────────────────────────────┐   │
│  │  Components          │   │  Hooks                        │   │
│  │  AppShell            │   │  useAgentSession              │   │
│  │  ChatWindow          │   │  useTheme (View Transitions)  │   │
│  │  SessionSidebar      │   │  useAudio (TTS sound effect)  │   │
│  │  ChatInput           │   │  useDragDrop (file upload)    │   │
│  │  MessageView         │   └──────┬─────────────────────────┘   │
│  │  MarkdownBody        │          │                            │
│  │  BranchNavigator     │   ┌──────▼─────────────────────────┐   │
│  │  FileViewer          │   │  agent-client.ts               │   │
│  │  ChatMinimap         │   │  window.electron.invoke()      │   │
│  │  ModelsConfig        │   │  window.electron.on()          │   │
│  │  SkillsConfig        │   └──────┬─────────────────────────┘   │
│  │  SessionStatsBar     │          │ IPC                        │
│  └──────────────────────┘          │                            │
├────────────────────────────────────┼────────────────────────────┤
│  Main Process (Node.js)            │                            │
│                                    ▼                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  preload.js (contextBridge → window.electron)            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                    │                            │
│  ┌────────────────────────────────▼─────────────────────────┐   │
│  │  ipc-handlers.js              ipc-handlers-files.js      │   │
│  │  ├─ get-sessions              ├─ list-dir                │   │
│  │  ├─ get-session               ├─ read-file               │   │
│  │  ├─ agent-new                 ├─ stat-file               │   │
│  │  ├─ agent-send                ├─ get-file-mime           │   │
│  │  ├─ agent-subscribe           └─ pi-file:// 协议          │   │
│  │  ├─ agent-get-state               app:// 协议             │   │
│  │  ├─ get-models                                              │   │
│  │  ├─ auth-* (OAuth)                                         │   │
│  │  └─ skills-* (技能商店)                                     │   │
│  └──────────────────────────┬──────────────────────────────┘   │
│                             │                                   │
│  ┌──────────────────────────▼──────────────────────────────┐   │
│  │  rpc-manager.js                                         │   │
│  │  AgentSessionWrapper (生命周期管理)                       │   │
│  │  ├─ globalThis.__piSessions (全局注册表)                  │   │
│  │  ├─ startRpcSession (延迟加载 ESM pi 模块)                │   │
│  │  ├─ 10 分钟空闲超时自动销毁                               │   │
│  │  └─ Fork 后立即 destroy 防止状态污染                      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                             │                                   │
│  ┌──────────────────────────▼──────────────────────────────┐   │
│  │  @earendil-works/pi-coding-agent  (ESM only)            │   │
│  │  @earendil-works/pi-ai                                  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 通信方式对比

| 维度 | Web 模式（旧） | Electron Desktop（当前） |
| :--- | :--- | :--- |
| 请求/响应 | `fetch()` HTTP 请求 | `ipcRenderer.invoke()` → `ipcMain.handle()` |
| 流式事件 | `EventSource` (SSE) | `ipcRenderer.on('agent-event-{id}')` 事件监听 |
| 文件读取 | `GET /api/files/*` | `pi-file://` 自定义协议 |
| 文件列表 | HTTP 请求 | `list-dir` IPC |
| 文件监听 | SSE 事件推送 | `fs.watch` + IPC 事件推送 |
| 会话控制 | `POST /api/agent/[id]` | `agent-send` IPC |
| 会话事件 | SSE `/api/agent/[id]/events` | `agent-subscribe` + IPC 事件推送 |
| 认证 | SSE 推送 + POST 回传 | 主进程主动派发 IPC 事件 + invoke 回传 |

## 功能

### 核心交互
- **会话管理** — 按工作目录分组展示所有 pi 会话，树形视图支持父子分支关系
- **实时对话** — IPC 事件流替代 SSE，与智能体实时交互，支持流式 Markdown 渲染
- **会话分叉 (Fork)** — 从任意用户消息创建独立的新 `.jsonl` 会话文件
- **会话内分支 (Branch)** — 回退到任意节点继续对话，同一文件内创建分支
- **分支导航器** — 可视化切换同一会话内的各个分支
- **模型切换** — 对话中途随时切换模型，支持思考等级调整 (`auto/off/minimal/low/medium/high/xhigh`)
- **工具面板** — 控制智能体可用的工具（预设：无 / 默认 / 全部）
- **会话压缩** — 长会话自动 / 手动摘要压缩，节省上下文窗口；支持中止压缩
- **智能重试** — 自动重试机制，失败时显示重试进度

### 文件与媒体
- **文件浏览器** — 侧边栏内置文件树，智能忽略 `node_modules`、`.git` 等目录
- **多格式预览** — 文本、图片、音频、PDF、DOCX（使用 mammoth 解析）
- **代码高亮** — 通过 `react-syntax-highlighter` 支持 190+ 语言
- **数学公式** — 通过 KaTeX 渲染 LaTeX 数学公式
- **Mermaid 图表** — 对话中直接渲染流程图、时序图等
- **拖拽上传** — 支持拖拽图片到聊天区域自动上传为 Base64

### UI 与体验
- **多 Tab 标签页** — 同时打开多个会话和文件，支持关闭
- **聊天缩略图 (Minimap)** — 消息列表侧边滚动缩略图，快速导航
- **音效反馈** — 助手回复完成时播放提示音（可开关）
- **暗色/亮色主题** — 自动跟随系统或手动切换，带 **View Transitions API** 圆形擦除动画
- **响应式布局** — 桌面端侧边栏滑动动画，移动端覆盖式抽屉

### 配置与集成
- **模型配置** — 内置 Models 配置面板，可视化编辑 `~/.pi/agent/models.json`
- **技能商店** — 浏览、搜索、安装 pi skills（通过 `skills.sh` API）
- **OAuth 登录** — 支持 GitHub Copilot、ChatGPT Plus/Pro 等 OAuth 提供商授权
- **会话导出** — 将对话导出为 HTML 文件
- **会话统计栏** — Token 用量（输入/输出/缓存读取/缓存写入）和费用统计
- **系统提示词查看** — 实时查看当前生效的系统提示词

## 项目结构

```
pi-desktop/
├── main.js                          # Electron 主进程入口
│                                    # 注册 pi-file://、app:// 特权协议
│                                    # 开发模式加载 localhost:30141
│                                    # 生产模式加载 app://-/
├── preload.js                       # contextBridge 暴露 electron.invoke / on
├── next.config.ts                   # Next.js 16 配置（静态导出 + 版本环境变量）
├── package.json                     # 依赖 + electron-builder 打包配置
│
├── bin/
│   └── pi-web.js                    # CLI 入口：启动 Next.js 生产 HTTP 服务
│       # 直接通过 node 调用 next/dist/bin/next start
│       # 避免 shell 注入，跨平台兼容
│
├── src/
│   ├── app/                         # Next.js App Router
│   │   ├── layout.tsx               # 根布局：Noto Sans Mono 字体 + KaTeX CSS + 暗色主题注入
│   │   ├── page.tsx                 # 首页，挂载 AppShell (Suspense 包裹)
│   │   ├── globals.css              # Tailwind CSS 4 + CSS 变量 + 主题 + 动画
│   │   └── favicon.ico
│   │
│   ├── components/                  # React UI 组件
│   │   ├── AppShell.tsx             # 顶层布局 + URL 状态同步 + Tab/侧边栏管理
│   │   ├── SessionSidebar.tsx       # 会话树 + 文件浏览器 + 新建/删除/重命名
│   │   ├── ChatWindow.tsx           # 消息列表 + 流式渲染 + fork/navigate 逻辑
│   │   ├── ChatInput.tsx            # 输入栏 + 模型/思考/工具/压缩/附件控件
│   │   ├── MessageView.tsx          # 单条消息渲染 (user/assistant/toolCall/toolResult)
│   │   ├── MarkdownBody.tsx         # Markdown 渲染 (react-markdown + 代码高亮 + Mermaid)
│   │   ├── BranchNavigator.tsx      # 会话内分支切换器
│   │   ├── ChatMinimap.tsx          # 消息列表滚动缩略图
│   │   ├── TabBar.tsx               # Tab 标签栏 (Chat + 已打开文件)
│   │   ├── FileExplorer.tsx         # 侧边栏文件树
│   │   ├── FileViewer.tsx           # 文件内容查看器（文本/图片/音频/PDF/DOCX）
│   │   ├── FileIcons.tsx            # 文件类型图标映射
│   │   ├── ToolPanel.tsx            # 工具预设管理 (PRESET_NONE/DEFAULT/FULL)
│   │   ├── ModelsConfig.tsx         # 模型配置弹窗
│   │   ├── SkillsConfig.tsx         # 技能商店面板
│   │   └── SessionStatsBar.tsx      # 会话统计栏 (Token/费用)
│   │
│   ├── hooks/                       # React Hooks
│   │   ├── useAgentSession.ts       # Agent 会话状态管理 + IPC 事件订阅
│   │   ├── useTheme.ts              # 暗色/亮色主题切换 (View Transitions API)
│   │   ├── useAudio.ts              # 音频播放 (AudioContext 合成提示音)
│   │   └── useDragDrop.ts           # 拖拽文件上传
│   │
│   ├── lib/                         # 客户端逻辑库
│   │   ├── agent-client.ts          # IPC 命令发送封装 (sendAgentCommand)
│   │   ├── types.ts                 # 共享 TypeScript 类型定义
│   │   ├── pi-types.ts              # Pi 引擎接口定义 (AgentSessionLike)
│   │   ├── normalize.ts             # toolCall 字段规范化 (pi file format → internal)
│   │   ├── file-paths.ts            # 文件路径处理 (编码/规范化/跨平台)
│   │   ├── markdown.ts              # Markdown 插件配置 (GFM/KaTeX/sanitize)
│   │   └── npx.ts                   # 安全跨平台 npx 包装器
│   │
│   ├── main/                        # Electron 主进程 (CommonJS)
│   │   ├── ipc-handlers.js          # 会话/Agent/模型/认证/技能 IPC 处理器
│   │   ├── ipc-handlers-files.js    # 文件系统 IPC + pi-file/app 协议处理器
│   │   └── rpc-manager.js           # AgentSession 生命周期管理
│   │
│   └── types/
│       └── electron.d.ts            # window.electron 全局类型声明
│
├── public/                          # 静态资源
└── docs/
    └── SKILL_find_skills.md         # 技能商店 API 说明
```

## 关键设计决策

### AgentSession 生命周期 (`src/main/rpc-manager.js`)

- 每个 session id 对应一个 `AgentSessionWrapper`，存储在 `globalThis.__piSessions`
- `globalThis` 比模块级 Map 更适合 — Next.js 热重载不影响主进程，主进程用 `global` 避免模块缓存问题
- 空闲 10 分钟自动 `destroy()`；并发调用通过 `globalThis.__piStartLocks` 共享 Promise
- 主进程动态 `import()` ESM-only 的 `@earendil-works/pi-coding-agent`

### Fork 后立即销毁 Wrapper

`AgentSession.fork()` 会**原地修改** wrapper 的 `sessionId` 为新会话 id。fork 后若不立即 `destroy()`，下一次请求会拿到已 fork 的状态，导致后续 fork 产生错误的 `parentSession` 链。

```js
// 正确做法 — rpc-manager.js
case "fork":
  // ... 创建新会话 ...
  this.destroy();  // ◄ 关键：立即销毁旧 wrapper
  return { cancelled: false, newSessionId };
```

### 两种分支，不要混淆

| 类型 | Fork | 会话内分支 |
| :--- | :--- | :--- |
| 触发方式 | 用户消息上的 Fork 按钮 | Continue 按钮 / BranchNavigator |
| 文件 | 创建独立 `.jsonl` 文件 | 同一文件内多 `parentId` |
| 关系 | header 中 `parentSession` 字段 | 多个条目共享 `parentId` |
| 切换 | 打开新 Tab | 调用 `navigate_tree` |

### ToolCall 字段规范化

Pi 引擎存储 toolCall 为 `{ type: "toolCall", id, name, arguments }`，但内部类型使用 `{ toolCallId, toolName, input }`。`normalize.ts` 中的 `normalizeToolCalls()` 负责转换，在 IPC 事件处理和文件加载中统一调用。

### 工具禁用时的系统提示词

当 `toolNames = []` 时，主进程清空 system prompt (`inner.agent.state.systemPrompt = ""`)，确保智能体在无工具模式下不产生误解。

### IPC 事件流 vs SSE

- 渲染进程调用 `window.electron.on('agent-event-{sid}')` 注册监听器
- 调用 `window.electron.invoke('agent-subscribe', sid)` 通知主进程开始推送
- 主进程通过 `AgentSessionWrapper.onEvent()` 接收 pi 引擎事件，`win.webContents.send()` 推送到渲染进程

### 会话压缩事件兼容

新旧 pi 版本分别使用 `compaction_start/end` 和 `auto_compaction_start/end`，前端 `useAgentSession` 同时处理两组事件名，保持 `isCompacting` 状态同步。手动压缩为阻塞 IPC，按钮在响应返回前保持禁用。

### 主题切换动画

使用 CSS View Transitions API 实现圆形擦除动画：

```css
::view-transition-old(root) { z-index: 1; }
::view-transition-new(root) { z-index: 2; }
```

`useTheme` hook 通过 `document.startViewTransition()` 触发，用 `Element.animate()` 驱动 `clip-path: circle()` 从点击位置展开。

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

- `parentSession` 仅用于侧边栏显示父子关系，不影响对话内容
- `entryIds[]` 与 `messages[]` 平行，每个消息映射到其 `.jsonl` 条目 id，用于 fork 和 navigate_tree

## IPC 调用列表

| Channel | Direction | 用途 |
| :--- | :--- | :--- |
| `get-sessions` | invoke | 列出所有会话 |
| `get-session` | invoke | 获取单个会话详情 |
| `get-session-context` | invoke | 获取指定 leaf 的上下文 |
| `delete-session` | invoke | 删除会话 |
| `update-session-name` | invoke | 重命名会话 |
| `agent-new` | invoke | 创建新 Agent 会话 |
| `agent-send` | invoke | 发送命令到 Agent |
| `agent-subscribe` | invoke | 订阅 Agent 事件推送 |
| `agent-get-state` | invoke | 获取 Agent 当前状态 |
| `agent-event-{sid}` | event | 主进程推送 Agent 事件 |
| `session-changed` | event | 会话文件变化通知 |
| `get-models` | invoke | 获取可用模型列表 |
| `list-dir` | invoke | 列出目录文件 |
| `read-file` | invoke | 读取文件内容 |
| `stat-file` | invoke | 获取文件信息 |
| `get-file-mime` | invoke | 获取文件 MIME 类型 |
| `skills-search` | invoke | 搜索技能商店 |
| `skills-install` | invoke | 安装技能 |
| `skills-uninstall` | invoke | 卸载技能 |
| `auth-*` | invoke | OAuth 授权流程 |

## 技术栈

| 层级 | 技术 |
| :--- | :--- |
| **前端框架** | React 19, Next.js 16 (App Router, static export) |
| **桌面框架** | Electron 42 (contextIsolation + preload) |
| **样式** | Tailwind CSS 4 (CSS variables + dark mode + View Transitions) |
| **Agent 引擎** | `@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai` (ESM only) |
| **Markdown** | react-markdown / remark-gfm / remark-math / rehype-katex / rehype-raw |
| **代码高亮** | react-syntax-highlighter (Prism, 190+ languages) |
| **图表** | Mermaid 11 |
| **文档** | mammoth (DOCX) |
| **字体** | Noto Sans Mono (Latin + Cyrillic) |
| **打包** | electron-builder (dmg / nsis) |

## 环境变量

| 变量 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `PI_CODING_AGENT_DIR` | 智能体数据目录 | `~/.pi/agent` |
| `SKILLS_API_URL` | 技能商店 API 地址 | `https://skills.sh` |
| `PORT` | pi-web HTTP 端口 | `30141` |
| `HOSTNAME` | pi-web 监听地址 | `localhost` |

## 许可

MIT
