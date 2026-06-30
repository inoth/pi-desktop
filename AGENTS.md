# Pi Agent Desktop - Agent Notes

This file is the working map for agents editing this repository. Keep changes scoped, preserve the session invariants below, and do not run `next build` during normal development.

## Quick Start

```bash
npm run dev
```

Development ports:

- Next.js dev server: `30141`
- Electron dev entry: `electron . --dev`, loaded after `wait-on http://localhost:30141`

Verification:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

Do not run `next build` during dev unless explicitly requested. It writes build artifacts and can interfere with the normal dev loop.

There is currently no test script and no discovered `*.test.*` / `*.spec.*` suite in this repo.

## Architecture Overview

```text
Browser / React / Next          Electron main process              AgentSession
        |                                |                              |
        | get-sessions / get-session     |                              |
        |------------------------------->| reads session .jsonl files   |
        |                                |                              |
        | agent-new / agent-send         |                              |
        |------------------------------->| startRpcSession()            |
        |                                |----------------------------->| createAgentSession()
        |                                |----------------------------->| prompt/send command
        |                                |                              |
        | agent-subscribe                |                              |
        |------------------------------->| session.onEvent()            |
        |<-------------------------------| agent-event-<id>             |
```

Important boundary:

- Session browsing is read-only. `get-sessions`, `get-session`, and `get-session-context` read `.jsonl` files directly through `SessionManager`; they do not create an `AgentSession`.
- Sending a message creates or restores an in-process `AgentSession` through `src/main/rpc-manager.js`.
- The renderer talks to Electron only through `window.electron.invoke/on` exposed by `preload.js`.

## Entrypoints

- `package.json`: scripts, Electron `main`, published `bin`.
- `main.js`: Electron app lifecycle, privileged protocol registration, IPC handler registration, BrowserWindow creation.
- `preload.js`: exposes `window.electron.invoke(channel, ...args)` and `window.electron.on(channel, handler)`.
- `src/app/layout.tsx`: root Next layout, global CSS, theme bootstrap script, `SessionProvider`.
- `src/app/page.tsx`: renders `AppShell`.
- `bin/pi-web.js`: published web CLI that starts the built Next app and opens a browser.

## Main Execution Chain

1. `npm run dev` starts `next dev -p 30141` and Electron.
2. `main.js` registers `app://` and `pi-file://`, then registers agent and file IPC handlers.
3. In dev, Electron loads `http://localhost:30141`; in production it loads `app://-/`.
4. `src/app/page.tsx` renders `AppShell`.
5. `SessionProvider` loads the session list with IPC `get-sessions`.
6. Selecting a session calls `get-session`; starting a new chat stores only a cwd until the first prompt creates the real session.
7. `ChatWindow` delegates all agent state and commands to `useAgentSession`.
8. `useAgentSession.handleSend()` sends:
   - new session: `agent-new -> startRpcSession(tempKey, "", cwd, toolNames) -> createAgentSession() -> prompt()`
   - existing session: `agent-send -> resolveSessionPath(id) -> startRpcSession(id, filePath, cwd) -> prompt()`
9. Live events flow back as `agent-event-<sessionId>` and are merged by `useAgentSession.handleAgentEvent()`.

## Key Files

### Main Process

- `src/main/rpc-manager.js`
  - Defines `AgentSessionWrapper`.
  - Owns live session registry on `global.__piSessions`.
  - Owns start locks on `global.__piStartLocks`.
  - Adapts UI commands to pi agent methods: `prompt`, `abort`, `fork`, `navigate_tree`, `set_model`, `set_tools`, `compact`, `steer`, `follow_up`, etc.

- `src/main/ipc-handlers.js`
  - Agent/session/model/auth/skills IPC.
  - Reads session files through pi `SessionManager`.
  - Wraps `buildSessionContext()` to provide UI-friendly messages and `entryIds`.
  - Handles model config, API keys, OAuth, session export, and skills install/search/list/patch.

- `src/main/ipc-handlers-files.js`
  - File browsing IPC: `register-workspace`, `cwd-validate`, `list-dir`, `read-file`, `file-meta`, `watch-file`.
  - Maintains allowed workspace roots for file access.
  - Serves `pi-file://` previews/streams and `app://` production assets.

### Renderer State and UI

- `src/context/SessionContext.tsx`
  - Global session list.
  - Per-session cached UI state stored in a ref to survive remounts.
  - Running/completed status used by tabs and sidebar.

- `src/hooks/useAgentSession.ts`
  - Core renderer-side agent state machine.
  - Loads sessions and contexts.
  - Connects/disconnects IPC event listeners.
  - Handles streaming state, optimistic user messages, message finalization, tool phases, retry info, compaction, fork, branch navigation, model/tool/thinking changes.

- `src/components/AppShell.tsx`
  - Top-level layout.
  - URL `?session=` restore.
  - Selected session/new-session cwd state.
  - Sidebar, chat area, file tabs, branch/system panels, model/skills modals.

- `src/components/SessionSidebar.tsx`
  - cwd selection and registration.
  - Session tree construction from `parentSessionId`.
  - Initial session restore from URL.
  - New/delete session actions and file explorer hosting.

- `src/components/ChatWindow.tsx`
  - Message list rendering.
  - Hooks `useAgentSession` into `ChatInput`, `MessageView`, minimap, drag/drop, audio notification, and stats bar.

- `src/components/ChatInput.tsx`
  - Prompt textarea.
  - Image attachments.
  - Model selector, tool preset selector, thinking-level selector, compact controls, sound toggle.

- `src/components/MessageView.tsx`
  - Renders user/assistant/tool messages.
  - Owns per-message fork/navigate/edit affordances.

- `src/components/ModelsConfig.tsx`
  - UI for `~/.pi/agent/models.json`.
  - OAuth/API-key model provider setup and model connection tests.

- `src/components/SkillsConfig.tsx`
  - Skills list, install/search UI, and prompt visibility toggle.

### Shared Utilities and Types

- `src/lib/types.ts`: UI-side session, message, entry, and tree contracts.
- `src/lib/normalize.ts`: converts pi tool call blocks `{ id, name, arguments }` to UI shape `{ toolCallId, toolName, input }`.
- `src/lib/agent-client.ts`: `sendAgentCommand()` helper for `agent-send`.
- `src/lib/file-paths.ts`: path encoding/display helpers for file browsing.
- `src/lib/markdown.ts` and `src/components/MarkdownBody.tsx`: markdown rendering support.

## Configuration and Injection

- There is no DI container. The main process dynamically imports pi packages inside async handlers.
- `@earendil-works/pi-coding-agent` provides `createAgentSession`, `SessionManager`, `getAgentDir`, `DefaultResourceLoader`, and session utilities.
- `@earendil-works/pi-ai` provides model/auth-related pieces such as `AuthStorage`, `ModelRegistry`, `SettingsManager`, and connection tests.
- `next.config.ts` injects `NEXT_PUBLIC_APP_VERSION` from this package and `NEXT_PUBLIC_PI_VERSION` from the installed pi package.
- Models are loaded through `ModelRegistry` and user config is persisted at `path.join(getAgentDir(), "models.json")`.
- Skills are loaded with `DefaultResourceLoader({ cwd, agentDir: getAgentDir() })`.
- File access is gated by `register-workspace` and the allowed roots in `src/main/ipc-handlers-files.js`.

## Session File Format

Location:

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

Representative entries:

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...]}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":123}
{"type":"session_info","id":"<8hex>","parentId":"<8hex>","name":"user-defined name"}
```

`entryIds[]` in the UI session context is parallel to `messages[]`. It maps each displayed message back to the corresponding `.jsonl` entry id and is used for fork and in-session branch navigation.

## Design Invariants and Traps

### AgentSession Lifecycle

- Keep one `AgentSessionWrapper` per real session id in `global.__piSessions`.
- Use `global.__piStartLocks` so concurrent starts for the same id share one promise.
- Keep the idle timeout behavior in `AgentSessionWrapper` unless deliberately replacing the lifecycle model.
- `global` is intentional because Electron/Next hot reload can invalidate module-level state.

### Fork Must Destroy the Wrapper

Forking mutates the inner pi session state in place. After a fork, `inner.sessionId` points at the new session. If the old wrapper remains registered under the old id, future forks can corrupt the `parentSession` chain.

Required behavior:

1. Capture `newSessionId`.
2. Update `global.pathCache` for the new id.
3. Call `this.destroy()` before returning.
4. Let the original session reload cleanly from its file on the next request.

### Two Branching Concepts

- Fork: creates a new independent `.jsonl` file and appears in the sidebar as a child through the header `parentSession`.
- In-session branch: stays inside the same `.jsonl` file and calls `navigate_tree`; switching branches uses `get-session-context` with a `leafId`.

Do not mix these concepts.

### Session Header Parent Is Display Metadata

`parentSession` in the header is only used to display the sidebar tree. It does not affect chat content. Delete/cascade reparenting may rewrite session file headers.

### Tool Call Normalization

Pi can store tool calls as:

```json
{"type":"toolCall","id":"...","name":"...","arguments":{}}
```

The renderer expects:

```json
{"type":"toolCall","toolCallId":"...","toolName":"...","input":{}}
```

Normalize through `src/lib/normalize.ts` or equivalent logic before rendering.

### Refresh During Streaming

On mount, `useAgentSession.connectEvents()` calls `agent-subscribe` and `agent-get-state`. If `state.isStreaming` is true, it restores streaming UI state and reconnects to live events.

### Compaction Events

Handle both event name generations:

- `compaction_start` / `compaction_end`
- `auto_compaction_start` / `auto_compaction_end`

Manual compact is a blocking command and should keep the UI disabled until the command resolves.

### File Access

Do not bypass `register-workspace` / `isPathAllowed()` for renderer-requested file reads or previews. `pi-file://`, skills patching, and file IPC should all honor allowed roots.

## High-Impact Areas

Treat these files as high risk:

- `src/main/ipc-handlers.js`: broad IPC surface and session file transformations.
- `src/main/rpc-manager.js`: live AgentSession lifecycle and fork correctness.
- `src/hooks/useAgentSession.ts`: streaming and UI state machine.
- `src/context/SessionContext.tsx`: cross-remount session cache and running status.
- `src/components/AppShell.tsx`: URL, selected session, cwd, and layout state.
- `src/main/ipc-handlers-files.js`: file access security boundary and protocol handling.
- `src/lib/types.ts`: message/session/tree contracts.

## Suggested Reading Order

1. `package.json`
2. `main.js`
3. `src/main/rpc-manager.js`
4. `src/main/ipc-handlers.js`
5. `src/hooks/useAgentSession.ts`
6. `src/context/SessionContext.tsx`
7. `src/components/AppShell.tsx`
8. `src/components/ChatWindow.tsx`
9. `src/components/SessionSidebar.tsx`
10. `src/main/ipc-handlers-files.js`

For model or skills changes, also read:

- `src/components/ModelsConfig.tsx`
- `src/components/SkillsConfig.tsx`

For file browsing changes, also read:

- `src/components/FileExplorer.tsx`
- `src/components/FileViewer.tsx`
- `src/components/TabBar.tsx`

## Testing and Verification Notes

No automated tests are currently present. For refactors, strongly consider adding focused characterization tests around:

- `projectTreeForResponse()` and `buildSessionContextWrapped()` behavior.
- `AgentSessionWrapper.send("fork")` registry/path-cache behavior.
- `useAgentSession` event merging for `message_update`, `message_end`, `agent_end`, and compaction events.
- `ipc-handlers-files.js` allowlist and path parsing.

At minimum, run:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

Manual smoke paths:

1. Start a new session in a cwd and send a prompt.
2. Refresh while an agent is streaming and confirm reconnect.
3. Fork from a user message and verify sidebar parent/child display.
4. Switch an in-session branch through the branch navigator.
5. Toggle tool preset, model, and thinking level.
6. Run manual compact and verify compaction UI clears.
7. Browse a registered workspace file and preview image/document/audio where relevant.

## CSS Variables

Defined in `src/app/globals.css`:

```text
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
