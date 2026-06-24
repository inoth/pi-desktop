/* eslint-disable @typescript-eslint/no-require-imports */
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const { getRpcSession, startRpcSession } = require('./rpc-manager.js');

// 动态导入 ESM 模块
async function loadPiModules() {
  const agent = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  return { ...agent, ...ai };
}

// 缓存会话路径
const pathCache = new Map();

async function resolveSessionPath(id) {
  if (pathCache.has(id)) return pathCache.get(id);
  const { SessionManager } = await loadPiModules();
  const piSessions = await SessionManager.listAll();
  for (const s of piSessions) pathCache.set(s.id, s.path);
  return pathCache.get(id) || null;
}

function normalizeToolCalls(msg) {
  if (msg.role !== "assistant" && msg.role !== "toolResult") return msg;
  const res = { ...msg };
  if (Array.isArray(res.content)) {
    res.content = res.content.map(b => {
      if (b.type !== "toolCall") return b;
      return {
        type: "toolCall",
        toolCallId: b.id || b.toolCallId,
        toolName: b.name || b.toolName,
        input: b.arguments || b.input
      };
    });
  }
  return res;
}

const MAX_PROJECTED_TREE_DEPTH = 200;

function projectTreeForResponse(nodes) {
  const keep = new Set();
  const roots = new Set(nodes);
  const seen = new Set();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);

    if (roots.has(node) || node.children.length !== 1) {
      keep.add(node);
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  const cloneNode = (node, compressedEntryIds) => ({
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
  });
  const projectedRoots = nodes.map((node) => cloneNode(node));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  const appendFlattenedKeptDescendants = (source, projectedParent) => {
    const pending = [{ node: source, compressedEntryIds: [] }];
    const flattenedSeen = new Set();

    while (pending.length > 0) {
      const { node, compressedEntryIds } = pending.pop();
      if (flattenedSeen.has(node)) continue;
      flattenedSeen.add(node);

      if (keep.has(node)) {
        projectedParent.children.push(cloneNode(node, compressedEntryIds));
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        pending.push({
          node: node.children[i],
          compressedEntryIds: keep.has(node)
            ? []
            : [...compressedEntryIds, node.entry.id],
        });
      }
    }
  };

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop();

    for (const sourceChild of source.children) {
      let child = sourceChild;

      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattenedKeptDescendants(child, projected);
        continue;
      }

      const compressedEntryIds = [];
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
      }

      if (!keep.has(child)) {
        continue;
      }

      const projectedChild = cloneNode(child, compressedEntryIds);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}

function buildSessionContextWrapped(buildSessionContext, entries, targetLeafId) {
  const byId = new Map();
  for (const e of entries) byId.set(e.id, e);
  const piCtx = buildSessionContext(entries, targetLeafId, byId);

  let targetLeaf;
  if (targetLeafId === null) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model };
  }
  if (targetLeafId) targetLeaf = byId.get(targetLeafId);
  if (!targetLeaf) targetLeaf = entries[entries.length - 1];
  if (!targetLeaf) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model };
  }

  const pathList = [];
  let cur = targetLeaf;
  while (cur) {
    pathList.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  let compactionId;
  let firstKeptEntryId;
  for (const e of pathList) {
    if (e.type === "compaction") {
      compactionId = e.id;
      firstKeptEntryId = e.firstKeptEntryId;
    }
  }

  const entryIds = [];
  if (compactionId) {
    entryIds.push(compactionId);
    const compactionIdx = pathList.findIndex((e) => e.id === compactionId);
    const firstKeptIdx = firstKeptEntryId
      ? pathList.findIndex((e, i) => i < compactionIdx && e.id === firstKeptEntryId)
      : -1;
    const startIdx = firstKeptIdx >= 0 ? firstKeptIdx : compactionIdx;
    for (let i = startIdx; i < compactionIdx; i++) {
      if (pathList[i].type === "message") entryIds.push(pathList[i].id);
    }
    for (let i = compactionIdx + 1; i < pathList.length; i++) {
      if (pathList[i].type === "message") entryIds.push(pathList[i].id);
    }
  } else {
    for (const e of pathList) {
      if (e.type === "message") entryIds.push(e.id);
    }
  }

  const messages = (piCtx.messages || []).map((msg) => {
    if (msg.role === "compactionSummary") {
      return {
        role: "user",
        content: `*The conversation history before this point was compacted into the following summary:*\n\n${msg.summary ?? ""}`,
        timestamp: msg.timestamp,
      };
    }
    return normalizeToolCalls(msg);
  });

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
  };
}

function registerIpcHandlers() {
  ipcMain.handle('agent-new', async (event, command) => {
    try {
      const { cwd, provider, modelId, toolNames, thinkingLevel, ...promptCommand } = command;

      if (!cwd || typeof cwd !== "string") {
        throw new Error("cwd is required");
      }
      if (!fs.existsSync(cwd)) {
        throw new Error(`Directory does not exist: ${cwd}`);
      }

      const tempKey = `__new__${Date.now()}`;
      const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, toolNames);

      if (provider && modelId) {
        await session.send({ type: "set_model", provider, modelId });
      }

      if (thinkingLevel) {
        await session.send({ type: "set_thinking_level", level: thinkingLevel });
      }

      const result = await session.send(promptCommand);

      return { success: true, sessionId: realSessionId, data: result };
    } catch (error) {
      throw new Error(String(error));
    }
  });

  ipcMain.handle('agent-send', async (event, id, command) => {
    try {
      const existing = getRpcSession(id);
      if (existing?.isAlive()) {
        const result = await existing.send(command);
        return { success: true, data: result };
      }

      const filePath = await resolveSessionPath(id);
      if (!filePath) {
        throw new Error("Session not found");
      }

      const { SessionManager } = await loadPiModules();
      const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();

      const { session } = await startRpcSession(id, filePath, cwd);
      const result = await session.send(command);

      return { success: true, data: result };
    } catch (error) {
      throw new Error(String(error));
    }
  });

  ipcMain.handle('agent-get-state', async (event, id) => {
    try {
      const session = getRpcSession(id);
      if (!session || !session.isAlive()) {
        return { running: false };
      }

      const state = await session.send({ type: "get_state" });
      return { running: true, state };
    } catch (error) {
      throw new Error(String(error));
    }
  });

  ipcMain.handle('agent-subscribe', async (event, id) => {
    let session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      const filePath = await resolveSessionPath(id);
      if (!filePath) {
        throw new Error("Session not found");
      }
      const { SessionManager } = await loadPiModules();
      const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
      try {
        ({ session } = await startRpcSession(id, filePath, cwd));
      } catch (error) {
        throw new Error(`Failed to start agent: ${error}`);
      }
    }

    event.sender.send(`agent-event-${id}`, { type: "connected", sessionId: id });

    const unsubscribe = session.onEvent((agentEvent) => {
      event.sender.send(`agent-event-${id}`, agentEvent);
    });

    return { success: true };
  });

  ipcMain.handle('agent-unsubscribe', async (_event, _id) => {
    // Cannot easily unsubscribe without keeping the reference, but we rely on WebContents destroyed to cleanup? 
    // Actually the session has idleTimer and cleans itself up.
    return { success: true };
  });

  ipcMain.handle('get-models', async () => {
    const nameMap = new Map();
    let modelList = [];
    let defaultModel = null;
    const thinkingLevels = {};
    const thinkingLevelMaps = {};

    try {
      const { AuthStorage, ModelRegistry, SettingsManager, getAgentDir, getSupportedThinkingLevels } = await loadPiModules();
      const agentDir = getAgentDir();
      const authStorage = AuthStorage.create();
      const registry = ModelRegistry.create(authStorage);
      const available = registry.getAvailable();
      modelList = available.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
      }));
      for (const m of available) {
        const key = `${m.provider}:${m.id}`;
        nameMap.set(key, m.name);
        thinkingLevels[key] = getSupportedThinkingLevels(m);
        if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
      }

      const settings = SettingsManager.create(process.cwd(), agentDir);
      const provider = settings.getDefaultProvider();
      const modelId = settings.getDefaultModel();
      if (provider) {
        defaultModel = { provider, modelId: modelId ?? available[0]?.id ?? "" };
      }
    } catch (e) {
      console.error("Failed to get models:", e);
    }

    return { 
      models: Object.fromEntries(nameMap), 
      modelList, 
      defaultModel, 
      thinkingLevels, 
      thinkingLevelMaps 
    };
  });

  ipcMain.handle('get-sessions', async () => {
    try {
      const { SessionManager } = await loadPiModules();
      const piSessions = await SessionManager.listAll();
      const pathToId = new Map();
      for (const s of piSessions) pathToId.set(s.path, s.id);

      const sessions = piSessions.map((s) => {
        pathCache.set(s.id, s.path);
        return {
          path: s.path,
          id: s.id,
          cwd: s.cwd,
          name: s.name,
          created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
          modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
          messageCount: s.messageCount,
          firstMessage: s.firstMessage || "(no messages)",
          parentSessionId: s.parentSessionPath ? pathToId.get(s.parentSessionPath) : undefined,
        };
      });
      return { sessions };
    } catch (e) {
      console.error("Failed to get sessions:", e);
      throw e;
    }
  });

  ipcMain.handle('get-session', async (event, id, includeState) => {
    try {
      const { SessionManager, buildSessionContext } = await loadPiModules();
      
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new Error("Session not found");

      const sm = SessionManager.open(filePath);
      const entries = sm.getEntries();
      const leafId = sm.getLeafId();
      
      const tree = projectTreeForResponse(sm.getTree());
      const context = buildSessionContextWrapped(buildSessionContext, entries, leafId);

      const header = sm.getHeader();
      let modified = header?.timestamp ?? new Date().toISOString();
      try { modified = fs.statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
      
      const piSessions = await SessionManager.listAll();
      const parentSessionId = piSessions.find((s) => s.id === id)?.parentSessionPath 
        ? piSessions.find(s => s.path === piSessions.find(s => s.id === id).parentSessionPath)?.id 
        : undefined;
      
      const info = header ? {
        path: filePath,
        id: header.id,
        cwd: header.cwd ?? "",
        name: sm.getSessionName(),
        created: header.timestamp,
        modified,
        messageCount: context.messages.length,
        firstMessage: context.messages.find((m) => m.role === "user")
          ? (() => {
              const msg = context.messages.find((m) => m.role === "user");
              const c = msg.content;
              return typeof c === "string" ? c : (Array.isArray(c) ? c.find(b => b.type === "text")?.text ?? "" : "") || "(no messages)";
            })()
          : "(no messages)",
        parentSessionId,
      } : null;

      let agentState;
      if (includeState) {
        agentState = { running: false };
      }

      return {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        context,
        ...(agentState !== undefined ? { agentState } : {}),
      };
    } catch (e) {
      console.error("Failed to get session:", e);
      throw e;
    }
  });

  ipcMain.handle('get-session-context', async (event, id, leafId) => {
    try {
      const { SessionManager, buildSessionContext } = await loadPiModules();
      
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new Error("Session not found");

      const sm = SessionManager.open(filePath);
      const entries = sm.getEntries();
      
      const context = buildSessionContextWrapped(buildSessionContext, entries, leafId);

      return { context };
    } catch (e) {
      console.error("Failed to get session context:", e);
      throw e;
    }
  });

  ipcMain.handle('update-session', async (event, id, { name }) => {
    try {
      const { SessionManager } = await loadPiModules();
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new Error("Session not found");
      
      const sm = SessionManager.open(filePath);
      sm.appendSessionInfo(name.trim());
      return { ok: true };
    } catch (e) {
      console.error("Failed to update session:", e);
      throw e;
    }
  });

  ipcMain.handle('delete-session', async (event, id) => {
    try {
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new Error("Session not found");

      // Read header before deleting to get parentSession path
      const firstLine = fs.readFileSync(filePath, "utf8").split("\n")[0];
      let parentSessionPath;
      try {
        const header = JSON.parse(firstLine);
        if (header.type === "session") parentSessionPath = header.parentSession;
      } catch { /* ignore */ }

      // Re-attach all direct children to this session's parent (cascade re-parent)
      const dir = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
      try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl") && path.join(dir, f) !== filePath);
        for (const file of files) {
          const childPath = path.join(dir, file);
          try {
            const content = fs.readFileSync(childPath, "utf8");
            const lines = content.split("\n");
            const header = JSON.parse(lines[0]);
            if (header.type === "session" && header.parentSession === filePath) {
              header.parentSession = parentSessionPath;
              lines[0] = JSON.stringify(header);
              fs.writeFileSync(childPath, lines.join("\n"));
            }
          } catch { /* skip malformed */ }
        }
      } catch { /* skip if dir unreadable */ }

      fs.unlinkSync(filePath);
      pathCache.delete(id);
      return { ok: true };
    } catch (e) {
      console.error("Failed to delete session:", e);
      throw e;
    }
  });

  ipcMain.handle('export-session', async (event, id) => {
    try {
      const { shell } = require('electron');
      const os = require('os');
      const { execFile } = require('child_process');
      const util = require('util');
      const execFileAsync = util.promisify(execFile);
      const { randomUUID } = require('crypto');
      
      const filePath = await resolveSessionPath(id);
      if (!filePath) throw new Error("Session not found");

      const cliUrl = require.resolve('@earendil-works/pi-coding-agent');
      const cliPath = path.join(path.dirname(cliUrl), "cli.js");
      
      if (!fs.existsSync(cliPath)) throw new Error("pi CLI not found");

      const tempDir = path.join(os.tmpdir(), "pi-web-export");
      fs.mkdirSync(tempDir, { recursive: true });

      const outputPath = path.join(tempDir, `${randomUUID()}.html`);

      try {
        await execFileAsync(process.execPath, [cliPath, "--export", filePath, outputPath], {
          cwd: process.cwd(),
          timeout: 30000,
          env: {
            ...process.env,
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
          },
          maxBuffer: 1024 * 1024,
        });
        
        // Let the OS handle the downloaded file or open it
        shell.showItemInFolder(outputPath);
        return { ok: true, path: outputPath };
      } catch (e) {
        if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
        throw e;
      }
    } catch (e) {
      console.error("Failed to export session:", e);
      throw e;
    }
  });
}

module.exports = { registerIpcHandlers };
