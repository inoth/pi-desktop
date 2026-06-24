# Pi Desktop

Pi Desktop 是 [pi 编程智能体](https://github.com/badlogic/pi-mono) 的跨平台桌面 GUI 应用。基于 **Electron** 架构，将原有的 Next.js Web 界面迁移为原生桌面应用，通过 IPC（进程间通信）取代 HTTP/SSE 实现更低延迟的交互体验。详细改造方案见 [MIGRATION_PLAN.md](./MIGRATION_PLAN.md)。

## 快速开始

```bash
# 开发模式
npm install
npm run dev        # 启动 Next.js (port 30141) + Electron 窗口

# 生产构建
npm run build      # Next.js 静态导出 + electron-builder 打包
```

## 架构

原 Next.js 的浏览器 ↔ Node.js 前后端分离架构，在 Electron 中统一为渲染进程 ↔ 主进程的 IPC 通信模型：

```
渲染进程 (Chromium)                    主进程 (Node.js)
  │                                        │
  ├─ window.electron.invoke('get-sessions')───▶ ipcMain.handle 读取 ~/.pi/agent/sessions/
  ├─ window.electron.invoke('agent-new') ──────▶ startRpcSession() → AgentSession 引擎
  ├─ window.electron.on('agent-event-*') ◀───── session.onEvent() 事件流
  ├─ pi-file:///Users/.../image.png ──────────▶ protocol.handle('pi-file') 自定义协议
  ├─ window.electron.invoke('list-dir') ──────▶ fs.readdirSync → JSON
  └─ window.electron.invoke('read-file') ─────▶ fs.readFileSync → content
```

**关键改造点**（详见 MIGRATION_PLAN.md）：

| 维度 | 原有 (Next.js Web) | 现 (Electron Desktop) |
| :--- | :--- | :--- |
| 基础通信 | `fetch()` HTTP 请求 | `ipcRenderer.invoke()` IPC 调用 |
| 流式通信 | `EventSource` (SSE) | `ipcRenderer.on` IPC 事件 |
| 文件读取 | `GET /api/files/*` | `pi-file://` 自定义协议 + `protocol.handle` |
| 文件列表 | HTTP 请求 | `list-dir` IPC 调用 |
| 文件监听 | SSE 推送 | `fs.watch` + IPC 事件推送 |
| 会话流 | SSE `/api/agent/[id]/events` | `agent-subscribe` + IPC 事件 |
| 认证授权 | SSE 推送验证码 + POST 回传 | 主进程主动派发 IPC 事件 + invoke 回传 |

## 功能

- **会话浏览器** — 按工作目录分组展示所有 pi 会话，支持树形视图
- **实时对话** — IPC 事件流替代 SSE，与智能体实时交互
- **会话分叉** — 从任意用户消息创建独立的新会话分支
- **会话内分支** — 回退到任意节点继续对话，在同一文件内创建分支
- **分支导航器** — 可视化切换同一会话内的各个分支
- **模型切换** — 对话中途随时切换模型，支持思考等级调整
- **工具面板** — 控制智能体可使用的工具（预设：无 / 默认 / 全部）
- **压缩会话** — 对长会话进行摘要，节省上下文窗口
- **文件浏览器** — 侧边栏内置文件树，支持文本/图片/音频/PDF/DOCX 预览
- **多 Tab 标签页** — 同时打开多个会话和文件
- **模型配置** — 内置 Models 配置面板，可视化编辑 `models.json`、管理 API Key
- **技能商店** — 浏览、搜索、安装 pi skills
- **OAuth 登录** — 支持 GitHub Copilot、ChatGPT Plus/Pro 等 OAuth 提供商授权
- **会话导出** — 将对话导出为 HTML 文件

## 项目结构

```
pi-desktop/
├── main.js                     # Electron 主进程入口
├── preload.js                  # preload 脚本：暴露 window.electron API
├── next.config.ts              # Next.js 配置（output: 'export' 静态导出）
├── package.json                # 依赖与 electron-builder 配置
│
├── src/main/                   # Electron 主进程逻辑
│   ├── ipc-handlers.js         # Agent / Session / Models / Auth / Skills IPC handlers
│   ├── ipc-handlers-files.js   # 文件系统 IPC handlers + pi-file/app 协议处理器
│   └── rpc-manager.js          # AgentSession 生命周期管理（原 lib/rpc-manager.ts）
│
├── app/                        # Next.js 页面路由（静态导出后嵌入 Electron）
├── components/                 # React UI 组件（100% 复用）
│   ├── AppShell.tsx            # 布局 + URL 状态 + Tab 管理
│   ├── SessionSidebar.tsx      # 会话树 + 文件浏览器
│   ├── ChatWindow.tsx          # 消息流 + IPC 事件 + fork/navigate
│   ├── ChatInput.tsx           # 输入栏 + 模型/思考/工具/压缩控制
│   ├── MessageView.tsx         # 单条消息渲染（user/assistant/toolCall/toolResult）
│   ├── BranchNavigator.tsx     # 会话内分支切换器
│   ├── FileExplorer.tsx        # 侧边栏文件树
│   ├── FileViewer.tsx          # 文件内容查看器（支持多类型预览）
│   └── ModelsConfig.tsx        # Models 配置弹窗
│
├── lib/                        # 业务逻辑（Node.js 侧）
│   ├── session-reader.ts       # .jsonl 会话文件解析
│   ├── rpc-manager.ts          # AgentSession 包装器 + registry
│   ├── normalize.ts            # toolCall 字段名规范化
│   └── types.ts                # 共享 TypeScript 类型
│
└── hooks/                      # React Hooks
```

## 会话文件格式

会话存储在 `~/.pi/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`：

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"message","id":"<8hex>","parentId":null,"message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...]}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>"}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

## 环境变量

| 变量 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `PI_CODING_AGENT_DIR` | 智能体数据目录 | `~/.pi/agent` |
| `SKILLS_API_URL` | 技能商店 API 地址 | `https://skills.sh` |

## 打包

```bash
npm run build     # 执行 next build + electron-builder
```

产出物位于 `dist/` 目录：

- macOS: `Pi Desktop-*.dmg`
- Windows: `Pi Desktop Setup *.exe`

## 技术栈

- **前端**: React 19, Next.js 16 (静态导出), Tailwind CSS 4
- **桌面框架**: Electron 42
- **Agent 引擎**: `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai`
- **Markdown**: react-markdown, remark-gfm, remark-math, rehype-katex
- **文档预览**: mammoth (DOCX)
- **打包**: electron-builder

## 许可

MIT
