/* eslint-disable @typescript-eslint/no-require-imports */
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const { getRpcSession, startRpcSession } = require('./rpc-manager.js');

// 缓存动态导入的 ESM 模块
let cachedPiModules = null;

async function loadPiModules() {
  if (cachedPiModules) return cachedPiModules;
  const agent = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  cachedPiModules = { ...agent, ...ai };
  return cachedPiModules;
}

// 缓存会话路径
const pathCache = new Map();
global.pathCache = pathCache;

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

    session.onEvent((agentEvent) => {
      event.sender.send(`agent-event-${id}`, agentEvent);
    });

    return { success: true };
  });

  ipcMain.handle('agent-unsubscribe', async () => {
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
            // Read only the first few bytes to get the header instead of the whole file
            const fd = fs.openSync(childPath, "r");
            const buffer = Buffer.alloc(4096);
            const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
            fs.closeSync(fd);
            
            const firstLineBytes = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
            const header = JSON.parse(firstLineBytes);
            
            if (header.type === "session" && header.parentSession === filePath) {
              header.parentSession = parentSessionPath;
              const newHeaderLine = JSON.stringify(header);
              
              // Rewrite the file with the new header
              const content = fs.readFileSync(childPath, "utf8");
              const contentWithoutOldHeader = content.substring(content.indexOf('\n') + 1);
              fs.writeFileSync(childPath, newHeaderLine + "\n" + contentWithoutOldHeader);
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

  ipcMain.handle('get-auth-providers', async () => {
    try {
      const { AuthStorage } = await loadPiModules();
      const authStorage = AuthStorage.create();
      const providers = authStorage.getOAuthProviders();

      const EXCLUDED = new Set(["anthropic"]);
      const DISPLAY_NAMES = {
        "openai-codex": "ChatGPT Plus/Pro",
        "github-copilot": "GitHub Copilot",
      };

      const result = await Promise.all(
        providers
          .filter((p) => !EXCLUDED.has(p.id))
          .map(async (p) => {
            const loggedIn = authStorage.has(p.id);
            return {
              id: p.id,
              name: DISPLAY_NAMES[p.id] ?? p.name,
              usesCallbackServer: p.usesCallbackServer ?? false,
              loggedIn,
            };
          })
      );

      return { providers: result };
    } catch (error) {
      throw new Error(String(error));
    }
  });

  ipcMain.handle('get-all-providers', async () => {
    try {
      const { AuthStorage, ModelRegistry } = await loadPiModules();
      const OAUTH_PROVIDER_IDS = new Set(["anthropic", "github-copilot", "openai-codex"]);
      
      const authStorage = AuthStorage.create();
      const registry = ModelRegistry.create(authStorage);
      const all = registry.getAll();

      const seen = new Set();
      const result = [];

      for (const m of all) {
        if (seen.has(m.provider)) continue;
        seen.add(m.provider);
        if (OAUTH_PROVIDER_IDS.has(m.provider)) continue;
        const status = registry.getProviderAuthStatus(m.provider);
        if (status.source === "models_json_key") continue;
        const displayName = registry.getProviderDisplayName(m.provider);
        const modelCount = all.filter((x) => x.provider === m.provider).length;
        result.push({
          id: m.provider,
          displayName,
          configured: status.configured,
          source: status.source,
          modelCount,
        });
      }

      return { providers: result };
    } catch (error) {
      throw new Error(String(error));
    }
  });

  const activeTokens = new Set();
  const loginCallbacksRegistry = new Map();

  ipcMain.handle('auth-login', async (event, provider) => {
    try {
      const { AuthStorage } = await loadPiModules();
      const authStorage = AuthStorage.create();
      const providers = authStorage.getOAuthProviders();
      const providerInfo = providers.find((p) => p.id === provider);
      
      if (!providerInfo) {
        throw new Error(`Unknown provider: ${provider}`);
      }

      let pendingManualRequest;

      const createClientInputRequest = () => {
        const token = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        activeTokens.add(token);

        const promise = new Promise((resolve, reject) => {
          loginCallbacksRegistry.set(token, {
            resolve: (value) => {
              activeTokens.delete(token);
              loginCallbacksRegistry.delete(token);
              resolve(value);
            },
            reject: (error) => {
              activeTokens.delete(token);
              loginCallbacksRegistry.delete(token);
              reject(error);
            },
          });
        });

        return { token, promise };
      };

      const getManualInputRequest = () => {
        if (!pendingManualRequest) {
          pendingManualRequest = createClientInputRequest();
          pendingManualRequest.promise
            .finally(() => {
              pendingManualRequest = undefined;
            })
            .catch(() => {});
        }
        return pendingManualRequest;
      };

      const cleanup = () => {
        for (const token of activeTokens) {
          loginCallbacksRegistry.get(token)?.reject(new Error("Login cancelled"));
          loginCallbacksRegistry.delete(token);
        }
        activeTokens.clear();
      };

      const abort = new AbortController();
      // Listen for window close or other cancels
      event.sender.once('destroyed', cleanup);

      try {
        await authStorage.login(provider, {
          onAuth: (info) => {
            const request = getManualInputRequest();
            event.sender.send(`auth-progress-${provider}`, {
              type: "auth",
              url: info.url,
              instructions: info.instructions ?? null,
              token: request.token,
            });
          },
          onDeviceCode: (info) => {
            event.sender.send(`auth-progress-${provider}`, {
              type: "device_code",
              userCode: info.userCode,
              verificationUri: info.verificationUri,
              intervalSeconds: info.intervalSeconds ?? null,
              expiresInSeconds: info.expiresInSeconds ?? null,
            });
          },
          onPrompt: async (prompt) => {
            const request = getManualInputRequest();
            event.sender.send(`auth-progress-${provider}`, {
              type: "prompt_request",
              message: prompt.message,
              placeholder: prompt.placeholder ?? null,
              token: request.token,
            });
            const value = await request.promise;
            return value;
          },
          onProgress: (message) => {
            event.sender.send(`auth-progress-${provider}`, { type: "progress", message });
          },
          onSelect: async (prompt) => {
            const request = createClientInputRequest();
            event.sender.send(`auth-progress-${provider}`, {
              type: "select_request",
              message: prompt.message,
              options: prompt.options,
              token: request.token,
            });
            const value = await request.promise;
            return value || undefined;
          },
          onManualCodeInput: () => getManualInputRequest().promise,
          signal: abort.signal,
        });

        event.sender.send(`auth-progress-${provider}`, { type: "success" });
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "Login cancelled") {
          event.sender.send(`auth-progress-${provider}`, { type: "error", message: msg });
        } else {
          event.sender.send(`auth-progress-${provider}`, { type: "cancelled" });
        }
        throw err;
      } finally {
        cleanup();
      }
    } catch (error) {
      throw new Error(String(error));
    }
  });

  ipcMain.handle('submit-auth-code', async (event, { provider, token, code }) => {
    if (!token || !code) {
      throw new Error("token and code required");
    }

    const callbacks = loginCallbacksRegistry.get(token);
    if (!callbacks) {
      throw new Error("No pending login for token");
    }
    
    if (!token.startsWith(`${provider}-`)) {
      throw new Error("Token does not match provider");
    }

    callbacks.resolve(code);
    loginCallbacksRegistry.delete(token);
    return { ok: true, provider };
  });

  ipcMain.handle('auth-logout', async (event, provider) => {
    try {
      const { AuthStorage } = await loadPiModules();
      const authStorage = AuthStorage.create();
      const providers = authStorage.getOAuthProviders();
      if (!providers.find((p) => p.id === provider)) {
        throw new Error(`Unknown provider: ${provider}`);
      }
      authStorage.logout(provider);
      return { ok: true };
    } catch (error) {
      throw new Error(String(error));
    }
  });

  ipcMain.handle('get-api-key-status', async (event, provider) => {
    try {
      const { AuthStorage, ModelRegistry } = await loadPiModules();
      const authStorage = AuthStorage.create();
      const registry = ModelRegistry.create(authStorage);
      const status = registry.getProviderAuthStatus(provider);
      const displayName = registry.getProviderDisplayName(provider);
      const models = registry.getAll().filter((m) => m.provider === provider).length;
      return { provider, displayName, configured: status.configured, source: status.source, models };
    } catch (error) {
      throw new Error(String(error));
    }
  });

  ipcMain.handle('save-api-key', async (event, provider, apiKey) => {
    try {
      if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
        throw new Error("apiKey is required");
      }
      const { AuthStorage } = await loadPiModules();
      const authStorage = AuthStorage.create();
      authStorage.set(provider, { type: "api_key", key: apiKey.trim() });
      return { success: true };
    } catch (error) {
      throw new Error(String(error));
    }
  });

  ipcMain.handle('delete-api-key', async (event, provider) => {
    try {
      const { AuthStorage } = await loadPiModules();
      const authStorage = AuthStorage.create();
      authStorage.remove(provider);
      return { success: true };
    } catch (error) {
      throw new Error(String(error));
    }
  });

  ipcMain.handle('get-models-config', async () => {
    try {
      const { getAgentDir } = await loadPiModules();
      const modelsPath = path.join(getAgentDir(), "models.json");
      if (!fs.existsSync(modelsPath)) {
        return {};
      }
      return JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
    } catch (error) {
      throw new Error(String(error));
    }
  });

  ipcMain.handle('save-models-config', async (event, config) => {
    try {
      const { getAgentDir } = await loadPiModules();
      const modelsPath = path.join(getAgentDir(), "models.json");
      const dir = path.dirname(modelsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      
      const tmpPath = `${modelsPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
      fs.renameSync(tmpPath, modelsPath);
      
      return { success: true };
    } catch (error) {
      throw new Error(String(error));
    }
  });

  ipcMain.handle('test-model-config', async (event, { providerName, provider, model }) => {
    try {
      const { testModelConnection } = await loadPiModules();
      const result = await testModelConnection(providerName, provider, model);
      return { ok: true, ...result };
    } catch (error) {
      throw new Error(String(error));
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

      let cliPath = null;
      let currentDir = __dirname;
      while (currentDir !== path.dirname(currentDir)) {
        const possiblePath = path.join(currentDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
        if (fs.existsSync(possiblePath)) {
          cliPath = possiblePath;
          break;
        }
        currentDir = path.dirname(currentDir);
      }
      
      if (!cliPath) throw new Error("pi CLI not found");

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
            ELECTRON_RUN_AS_NODE: "1",
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

  ipcMain.handle('skills-list', async (event, { cwd }) => {
    try {
      if (!cwd) throw new Error("cwd required");
      const { DefaultResourceLoader, getAgentDir } = await loadPiModules();
      const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
      await loader.reload();
      const { skills, diagnostics } = loader.getSkills();
      return { skills, diagnostics };
    } catch (e) {
      return { error: String(e) };
    }
  });

  ipcMain.handle('skills-patch', async (event, { filePath, disableModelInvocation }) => {
    try {
      if (!filePath) throw new Error("filePath required");
      const { isPathAllowed, getAllowedRoots } = require('./ipc-handlers-files.js');
      const allowedRoots = await getAllowedRoots();
      if (!isPathAllowed(filePath, allowedRoots)) throw new Error("Access denied");
      if (!fs.existsSync(filePath)) throw new Error("file not found");

      const content = fs.readFileSync(filePath, "utf8");
      const key = "disable-model-invocation";

      const { parseFrontmatter } = await loadPiModules();
      const { frontmatter } = parseFrontmatter(content);
      const alreadySet = Boolean(frontmatter[key]);

      let updated = content;
      if (disableModelInvocation && !alreadySet) {
        updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
        if (updated === content) updated = `---\n${key}: true\n---\n${content}`;
      } else if (!disableModelInvocation && alreadySet) {
        updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
      }

      fs.writeFileSync(filePath, updated, "utf8");
      return { success: true };
    } catch (e) {
      return { error: String(e) };
    }
  });

  ipcMain.handle('skills-install', async (event, { package: pkg, scope, cwd }) => {
    try {
      if (!pkg?.trim()) throw new Error("package required");
      const isGlobal = scope !== "project";
      const args = ["skills", "add", pkg.trim(), "-y", "--agent", "pi"];
      if (isGlobal) args.push("-g");

      
      // Fallback implementation since we can't easily require the TS file in the main process
      const { execFile } = require("child_process");
      const util = require("util");
      const execFileAsync = util.promisify(execFile);
      
      const nodeDir = path.dirname(process.execPath);
      const candidates = [
        path.join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
        path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
      ];
      let npxCli = null;
      for (const p of candidates) {
        if (fs.existsSync(p)) { npxCli = p; break; }
      }

      const { command, commandArgs } = npxCli
        ? { command: process.execPath, commandArgs: [npxCli, ...args] }
        : { command: "npx", commandArgs: args };

      const env = { ...process.env, FORCE_COLOR: "0" };
      if (npxCli) {
        env.ELECTRON_RUN_AS_NODE = "1";
      }

      const { stdout, stderr } = await execFileAsync(command, commandArgs, {
        timeout: 60000,
        cwd: !isGlobal && cwd ? cwd : undefined,
        env,
      });

      const ANSI_RE = /\x1B\[[0-9;]*m/g;
      const output = (stdout + stderr).replace(ANSI_RE, "");
      const success = /Installation complete|Installed \d+ skill/.test(output);
      
      if (!success) {
        return { error: output.slice(-300) || "Install failed" };
      }
      return { success: true, output };
    } catch (e) {
      const ANSI_RE = /\x1B\[[0-9;]*m/g;
      const output = ((e.stdout ?? "") + (e.stderr ?? "")).replace(ANSI_RE, "");
      return { error: output || (e.message ?? String(e)) };
    }
  });

  ipcMain.handle('skills-search', async (event, { query, limit = 50 }) => {
    try {
      if (!query?.trim()) throw new Error("query required");
      
      const SEARCH_API_BASE = process.env.SKILLS_API_URL || "https://skills.sh";
      const url = `${SEARCH_API_BASE}/api/search?q=${encodeURIComponent(query.trim())}&limit=${limit}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`skills.sh search failed: HTTP ${res.status}`);
      
      const data = await res.json();
      
      const formatInstalls = (count) => {
        if (!count || count <= 0) return "";
        if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
        if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
        return `${count} install${count === 1 ? "" : "s"}`;
      };

      const parseInstallCount = (installs) => {
        const match = installs.match(/^([\d.]+)([KMB])?\s+installs?$/);
        if (!match) return 0;
        const value = Number(match[1]);
        if (!Number.isFinite(value)) return 0;
        const multiplier = match[2] === "B" ? 1_000_000_000 : match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
        return value * multiplier;
      };

      const results = (data.skills ?? [])
        .map((skill) => {
          const name = skill.name?.trim();
          const source = skill.source?.trim();
          const slug = skill.id?.trim();
          if (!name || (!source && !slug)) return null;

          const pkg = `${source || slug}@${name}`;
          return {
            package: pkg,
            installs: formatInstalls(skill.installs),
            url: slug ? `${SEARCH_API_BASE}/${slug}` : "",
          };
        })
        .filter((skill) => skill !== null)
        .sort((a, b) => parseInstallCount(b.installs) - parseInstallCount(a.installs));

      return { results: results.slice(0, limit) };
    } catch (e) {
      try {
        const { execFile } = require("child_process");
        const util = require("util");
        const execFileAsync = util.promisify(execFile);
        
        const nodeDir = path.dirname(process.execPath);
        const candidates = [
          path.join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
          path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
        ];
        let npxCli = null;
        for (const p of candidates) {
          if (fs.existsSync(p)) { npxCli = p; break; }
        }

        const { command, commandArgs } = npxCli
          ? { command: process.execPath, commandArgs: [npxCli, "skills", "find", query.trim()] }
          : { command: "npx", commandArgs: ["skills", "find", query.trim()] };

        const { stdout, stderr } = await execFileAsync(command, commandArgs, {
          timeout: 20000,
          env: { ...process.env, FORCE_COLOR: "0" },
        });

        const ANSI_RE = /\x1B\[[0-9;]*m/g;
        const clean = (stdout + stderr).replace(ANSI_RE, "");
        const results = [];
        const lines = clean.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          const pkgMatch = line.match(/^([\w.\-]+\/[\w.\-@:]+)\s+([\d.,]+[KMB]?\s+installs)$/);
          if (pkgMatch) {
            const urlLine = lines[i + 1]?.trim().replace(/^└\s*/, "");
            results.push({
              package: pkgMatch[1],
              installs: pkgMatch[2],
              url: urlLine?.startsWith("https://") ? urlLine : "",
            });
          }
        }
        return { results: results.slice(0, limit) };
      } catch {
        return { error: String(e) };
      }
    }
  });
}

module.exports = { registerIpcHandlers };
