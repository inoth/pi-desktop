# Pi Desktop `feat/desktop` 代码审查及优化 TODO 列表

基于对 `feat/desktop` 分支的 Code Review，整理出以下性能瓶颈修复和架构优化任务。

## 🔴 核心性能问题修复 (High Priority)

- [x] **重构主进程文件系统读取 (解决主线程阻塞)**
  - **文件**: `src/main/ipc-handlers-files.js`
  - **问题**: `getAllowedRoots()` 中使用了 `fs.readdirSync(os.homedir())`，且在每次文件操作 IPC (`read-file`, `list-dir`, `file-meta`) 中被调用。如果主目录文件较多，会导致应用严重卡顿。
  - **行动**:
    1. 在应用启动时或 `register-workspace` 时缓存 `allowedRoots` 列表，而不是每次实时读取。
    2. 将所有文件系统操作（如 `fs.readFileSync`, `fs.readdirSync`, `fs.statSync`）替换为非阻塞的异步版本 (`fs.promises.*`)。

- [x] **修复 React 状态提升导致的全局无意义重渲染**
  - **文件**: `src/components/AppShell.tsx` & `src/components/ChatWindow.tsx`
  - **问题**: 模型流式输出时高频触发 `onSessionStatsChange` 和 `onContextUsageChange`，导致庞大的顶层组件 `AppShell` 持续重渲染，消耗 CPU 并可能引起 UI 掉帧。
  - **行动**: 将顶部 Token/Cost 统计栏抽离为独立组件，通过 Context、Zustand 或 EventEmitter 将更新直接发送到该子组件，从而切断对 `AppShell` 的渲染链。

- [x] **优化主进程动态模块导入性能**
  - **文件**: `src/main/ipc-handlers.js`
  - **问题**: `loadPiModules()` 在多数 IPC 处理器中频繁调用，频繁的 `import()` 会带来微任务调度开销。
  - **行动**: 实现单例模式，将动态导入的结果缓存到全局变量中。

## 🟡 架构设计及鲁棒性优化 (Medium Priority)

- [ ] **完善 IPC 订阅机制，防止内存泄漏**
  - **文件**: `src/main/rpc-manager.js` (`AgentSessionWrapper`) & 前端组件
  - **问题**: 目前依赖 10 分钟的 `idleTimer` 来销毁 Session Wrapper。`ipcMain.handle('agent-unsubscribe')` 中未执行实质清理。
  - **行动**: 在前端对应的 `useEffect` cleanup 中发送注销事件，主进程收到后应立刻移除对应的 Event Listeners。

- [ ] **优化 EventSource 断线重连逻辑**
  - **文件**: `src/hooks/useAgentSession.ts` -> `connectEvents`
  - **问题**: `onerror` 后以 1 秒固定频率重连，若后端服务宕机，会导致前端陷入疯狂请求的死循环。
  - **行动**: 引入指数退避 (Exponential Backoff) 算法（例如 1s, 2s, 4s, 8s），并设置最大重试次数阈值，超过后展示友好的 UI 错误提示。

- [ ] **增强文件系统监听 (File Watcher) 的稳定性**
  - **文件**: `src/main/ipc-handlers-files.js`
  - **问题**: 直接使用原生的 `fs.watch` 在跨平台桌面应用中易出现双重触发、句柄耗尽、某些编辑器下 watch 丢失等问题。
  - **行动**: 引入 `chokidar` 库替代原生 `fs.watch`。

- [ ] **提升子进程回退逻辑 (Fallback Exec) 的可靠性**
  - **文件**: `src/main/ipc-handlers.js` (`skills-install` / `skills-search`)
  - **问题**: 通过 `child_process.execFile` 启动 `npx`，在 Electron 生产环境中容易因为 `PATH` 环境变量缺失而失败。
  - **行动**: 尽可能以 Node API (Library) 的形式直接引用核心模块调用，而非依赖系统的命令行环境。
