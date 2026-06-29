# Pi Agent Desktop - Development Notes

## Quick Start

```bash
npm run dev   # port 3030
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `node node_modules/next/dist/bin/next lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

---

## Architecture

```
Browser (React)               Electron Main Process          AgentSession (in-process)
  │                                    │                               │
  ├─ IPC get-sessions ────────────────▶│ reads ~/.pi/agent/sessions/   │
  ├─ IPC get-session ─────────────────▶│ reads .jsonl file directly    │
  │                                    │                               │
  ├─ IPC agent-send ──────────────────▶│ startRpcSession() ───────────▶│ createAgentSession()
  │                                    │ session.send(cmd) ───────────▶│ session.prompt()
  │                                    │                               │
  ├─ IPC agent-subscribe ─────────────▶│ session.onEvent() ◀───────────│ session.subscribe()
  │◀── IPC agent-event-<id> ───────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files directly via IPC `get-sessions` and `get-session` — no AgentSession created.  
**Sending a message**: `startRpcSession()` in `src/main/rpc-manager.js` creates an AgentSession in-process.

---

## File Map

```
src/main/
  ipc-handlers.js     Electron IPC handlers (agent-new, get-sessions, etc.)
  ipc-handlers-files.js Electron IPC handlers for file operations
  rpc-manager.js      AgentSessionWrapper + registry + startRpcSession

src/lib/
  agent-client.ts     Client-side helper for agent IPC (sendAgentCommand)
  file-paths.ts       Path resolution utilities
  markdown.ts         Markdown processing
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  npx.ts              NPX execution utilities
  pi-types.ts         Shared TypeScript types
  types.ts            Shared TypeScript types

src/components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      messages + streaming + SSE + fork/navigate logic
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  ToolPanel.tsx       exports PRESET_NONE/DEFAULT/FULL + getPresetFromTools
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  FileExplorer.tsx    file tree inside sidebar
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)
  SessionStatsBar.tsx Session statistics display
  SkillsConfig.tsx    Skills configuration modal

src/hooks/
  useAgentSession.ts  React hook for managing agent session state via IPC
  useAudio.ts         Audio playback hook
  useDragDrop.ts      Drag and drop hook
  useTheme.ts         Theme management hook
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`src/main/rpc-manager.js`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls IPC `get-session-context` with `leafId`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `src/lib/normalize.ts` handles this.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, IPC `agent-get-state` is called. If `state.isStreaming === true`, SSE is reconnected automatically via IPC `agent-subscribe`. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking IPC call — the button stays disabled until the response returns.

### Orphaned sessions
Sessions whose first line can't be parsed as a valid header are marked `orphaned: true` in the API response — displayed with an "incomplete" badge in the sidebar and not clickable.

---

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## CSS Variables (`src/app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```