"use client";

import { useState, useCallback, useRef, useEffect, useReducer } from "react";
import type { AgentMessage, SessionInfo, SessionTreeNode } from "@/lib/types";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ToolEntry } from "@/components/ToolPanel";
import { useGlobalSessionContext } from "@/context/SessionContext";

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  setNewSessionModel?: (model: { provider: string; modelId: string } | null) => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  addImages: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange,
  } = opts;

  const { getSession, updateSession } = useGlobalSessionContext();
  const sessionId = session?.id;
  const globalState = sessionId ? getSession(sessionId) : null;

  // Track which session this hook instance's state belongs to.
  // This prevents the "transition render" from corrupting another session's state
  // when AppShell updates the session prop but the component hasn't remounted yet.
  const stateSessionIdRef = useRef(sessionId);
  if (!stateSessionIdRef.current && sessionId) {
    stateSessionIdRef.current = sessionId;
  } else if (sessionId && stateSessionIdRef.current !== sessionId) {
    // If sessionId changed, we should NOT sync our old state to the new sessionId
    // This is handled by the useEffect check below.
  }

  const isNew = session === null && newSessionCwd !== null;

  const [data, setDataState] = useState<SessionData | null>(globalState?.data ?? null);
  const [loading, setLoading] = useState(!isNew && !globalState);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafIdState] = useState<string | null>(globalState?.activeLeafId ?? null);
  const [messages, setMessagesState] = useState<AgentMessage[]>(globalState?.messages ?? []);
  const [entryIds, setEntryIdsState] = useState<string[]>(globalState?.entryIds ?? []);
  const [streamState, dispatch] = useReducer(streamReducer, globalState?.streamState ?? { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunningState] = useState(globalState?.agentRunning ?? false);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<{ id: string; name: string; provider: string }[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModelState] = useState<{ provider: string; modelId: string } | null>(null);
  const [toolPreset, setToolPresetStateInternal] = useState<"none" | "default" | "full">(globalState?.toolPreset ?? "default");
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevelOption>(globalState?.thinkingLevel ?? "auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsageState] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(globalState?.contextUsage ?? null);
  const [systemPrompt, setSystemPromptState] = useState<string | null>(globalState?.systemPrompt ?? null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompactingState] = useState(globalState?.isCompacting ?? false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhaseState] = useState<AgentPhase>(globalState?.agentPhase ?? null);

  const setData = useCallback((d: SessionData | null) => {
    setDataState(d);
  }, []);

  const setActiveLeafId = useCallback((id: string | null) => {
    setActiveLeafIdState(id);
  }, []);

  const setMessages = useCallback((msgs: AgentMessage[] | ((prev: AgentMessage[]) => AgentMessage[])) => {
    setMessagesState(msgs);
  }, []);

  const setEntryIds = useCallback((ids: string[]) => {
    setEntryIdsState(ids);
  }, []);

  const setAgentRunning = useCallback((running: boolean) => {
    setAgentRunningState(running);
  }, []);

  const setThinkingLevel = useCallback((level: ThinkingLevelOption) => {
    setThinkingLevelState(level);
  }, []);

  const setToolPreset = useCallback((preset: "none" | "default" | "full") => {
    setToolPresetStateInternal(preset);
  }, []);

  const setContextUsage = useCallback((usage: any) => {
    setContextUsageState(usage);
  }, []);

  const setSystemPrompt = useCallback((prompt: string | null) => {
    setSystemPromptState(prompt);
  }, []);

  const setIsCompacting = useCallback((compacting: boolean) => {
    setIsCompactingState(compacting);
  }, []);

  const setAgentPhase = useCallback((phase: AgentPhase | ((prev: AgentPhase) => AgentPhase)) => {
    setAgentPhaseState(phase);
  }, []);

  // Sync state to global context in a controlled way via useEffect
  useEffect(() => {
    if (!sessionId || sessionId !== stateSessionIdRef.current) return;
    updateSession(sessionId, {
      data,
      messages,
      agentRunning,
      streamState,
      thinkingLevel,
      toolPreset,
      contextUsage,
      systemPrompt,
      isCompacting,
      agentPhase,
      activeLeafId,
      entryIds,
    });

    // Broadcast running status for components like TabBar that listen via events.
    // Only emit on transitions so a completed marker is not refreshed by unrelated state syncs.
    if (typeof window !== "undefined") {
      const previousRunning = lastBroadcastRunningRef.current;
      if (previousRunning !== agentRunning) {
        lastBroadcastRunningRef.current = agentRunning;
        window.dispatchEvent(new CustomEvent("pi-session-running-status-update", {
          detail: {
            sessionId,
            running: agentRunning,
            completedAt: previousRunning === true && !agentRunning ? Date.now() : undefined,
          }
        }));
      }
    }
  }, [
    sessionId,
    data,
    messages,
    agentRunning,
    streamState,
    thinkingLevel,
    toolPreset,
    contextUsage,
    systemPrompt,
    isCompacting,
    agentPhase,
    activeLeafId,
    entryIds,
    updateSession // updateSession is now stable via useCallback in Context
  ]);

  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const agentRunningRef = useRef(globalState?.agentRunning ?? false);
  const lastBroadcastRunningRef = useRef<boolean | null>(globalState?.agentRunning ?? null);
  const handleAgentEventRef = useRef<((event: { type: string; [key: string]: unknown }) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const setNewSessionModel = opts.setNewSessionModel ?? setNewSessionModelState;
  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? newSessionModel : currentModel;

  const sessionStats = (() => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    return total > 0 ? { tokens, cost } : null;
  })();

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    try {
      if (showLoading) setLoading(true);
      const data = (await window.electron.invoke('get-session', sid, includeState));
      if (!data) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setError(null);
        }
        return null;
      }
      const d = data as SessionData & { agentState?: { running: boolean; state?: { isStreaming?: boolean; isCompacting?: boolean; contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null; systemPrompt?: string; thinkingLevel?: string } } };
      setData(d);
      setActiveLeafId(d.leafId);
      
      const newMessages = (d as { context?: { messages: AgentMessage[]; entryIds: string[]; thinkingLevel?: string } }).context?.messages ?? [];
      
      setMessages((prev) => {
        // If disk has fewer messages than we already have locally, 
        // it's likely that the disk is lagging behind or we have optimistic updates.
        // In this case, keep the local messages.
        if (newMessages.length < prev.length) {
          return prev;
        }
        // If they are the same length, we can still update to get potential metadata changes,
        // but generally prev is fine.
        return newMessages;
      });

      setEntryIds((d as { context?: { messages: AgentMessage[]; entryIds: string[]; thinkingLevel?: string } }).context?.entryIds ?? []);
      setCurrentModelOverride(null);
      setError(null);
      // If no live agent state, fall back to thinking level from session file
      if (!d.agentState?.state?.thinkingLevel && (d as { context?: { messages: AgentMessage[]; entryIds: string[]; thinkingLevel?: string } }).context?.thinkingLevel && (d as { context?: { messages: AgentMessage[]; entryIds: string[]; thinkingLevel?: string } }).context?.thinkingLevel !== "off") {
        setThinkingLevel((d as { context?: { messages: AgentMessage[]; entryIds: string[]; thinkingLevel?: string } }).context?.thinkingLevel as ThinkingLevelOption);
      }
      return d.agentState ?? null;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [setData, setActiveLeafId, setThinkingLevel]);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    try {
      const d = (await window.electron.invoke('get-session-context', sid, leafId));
      setMessages((d as { context?: { messages: AgentMessage[]; entryIds: string[]; thinkingLevel?: string } }).context?.messages ?? []);
      setEntryIds((d as { context?: { messages: AgentMessage[]; entryIds: string[]; thinkingLevel?: string } }).context?.entryIds ?? []);
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, [setMessages, setEntryIds]);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/components/ToolPanel");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  const connectEvents = useCallback((sid: string) => {
    if (eventSourceRef.current) {
      // Here eventSourceRef.current is acting as a cleanup function for IPC
      ((eventSourceRef.current as unknown) as () => void)();
      eventSourceRef.current = null;
    }
    
    // Always sync latest session data from disk when connecting events
    // to catch any messages that arrived while we were unmounted.
    loadSession(sid);
    
    const cleanup = window.electron.on(`agent-event-${sid}`, ((event: { type: string; [key: string]: unknown }) => {
      try {
        handleAgentEventRef.current?.(event);
      } catch (e) {
        console.error("Agent event handler error:", e);
      }
    }) as (...args: unknown[]) => void);
    eventSourceRef.current = cleanup as unknown as EventSource;
    
    // Tell main process to subscribe and send events
    window.electron.invoke('agent-subscribe', sid).catch((e: Error) => {
      console.error("Failed to subscribe to agent events:", e);
    });

    window.electron.invoke('agent-get-state', sid)
      .then(((d: unknown) => {
        const data = d as { running: boolean; state?: { isStreaming?: boolean; isCompacting?: boolean; contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null; systemPrompt?: string; thinkingLevel?: string; errorMessage?: string; streamingMessage?: unknown } };
        if (data.state) {
          if (data.state.isCompacting !== undefined) setIsCompacting(data.state.isCompacting);
          if (data.state.contextUsage !== undefined) setContextUsage(data.state.contextUsage ?? null);
          if (data.state.systemPrompt !== undefined) setSystemPrompt(data.state.systemPrompt ?? null);
          if (data.state.thinkingLevel !== undefined) setThinkingLevel((data.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (data.state.isStreaming !== undefined) {
             if (data.state.isStreaming) {
               setAgentRunning(true);
               agentRunningRef.current = true;
               // Don't overwrite agent phase if it's already set to something more specific (like tools)
               setAgentPhase(prev => prev || { kind: "waiting_model" });
               dispatch({ type: "start" });
               if (data.state.streamingMessage) {
                  dispatch({ type: "update", message: normalizeToolCalls(data.state.streamingMessage as AgentMessage) });
               }
             } else {
               setAgentRunning(false);
               agentRunningRef.current = false;
               setAgentPhase(null);
               dispatch({ type: "end" });
               // Final sync if stopped
               loadSession(sid);
             }
          } else if (data.running) {
             // Fallback if isStreaming is not explicitly in state but the session is running
             setAgentRunning(true);
             agentRunningRef.current = true;
             setAgentPhase(prev => prev || { kind: "waiting_model" });
             dispatch({ type: "start" });
          } else {
             // Not running
             setAgentRunning(false);
             agentRunningRef.current = false;
             setAgentPhase(null);
             dispatch({ type: "end" });
             loadSession(sid);
          }
        } else if (data.running) {
          // Absolute fallback if data.state is undefined but session is running
          setAgentRunning(true);
          agentRunningRef.current = true;
          setAgentPhase(prev => prev || { kind: "waiting_model" });
          dispatch({ type: "start" });
        } else {
          // Not running
          setAgentRunning(false);
          agentRunningRef.current = false;
          setAgentPhase(null);
          dispatch({ type: "end" });
          loadSession(sid);
        }
      }) as (value: unknown) => void)
      .catch(() => {});
  }, [setIsCompacting, setContextUsage, setSystemPrompt, setThinkingLevel, setAgentRunning, setAgentPhase, loadSession]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: { type: string; [key: string]: unknown }) => {
    switch (event.type) {
      case "agent_start":
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        agentRunningRef.current = false;
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          loadSession(sessionIdRef.current);
          window.electron.invoke('agent-get-state', sessionIdRef.current)
            .then(((d: unknown) => {
              const data = d as { state?: { contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null; systemPrompt?: string } };
              if (data.state?.contextUsage !== undefined) setContextUsage(data.state.contextUsage ?? null);
              if (data.state?.systemPrompt !== undefined) setSystemPrompt(data.state.systemPrompt ?? null);
            }) as (value: unknown) => void)
            .catch(() => {});
        }
        onAgentEnd?.();
        break;
      case "message_start":
      case "message_update": {
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role !== "user") {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
    }
  }, [loadSession, onAgentEnd, setAgentRunning, setAgentPhase, setMessages, setIsCompacting, setContextUsage, setSystemPrompt]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    if (!message.trim() && !images?.length) return;
    if (agentRunning) return;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase({ kind: "waiting_model" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    completionScrollAllowedRef.current = true;

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        if (selectedModel) setPendingModel(selectedModel);
        const { PRESET_NONE, PRESET_DEFAULT, PRESET_FULL } = await import("@/components/ToolPanel");
        const toolNames = toolPreset === "none" ? PRESET_NONE : toolPreset === "default" ? PRESET_DEFAULT : PRESET_FULL;
        
        const result = await window.electron.invoke('agent-new', {
          cwd: newSessionCwd,
          type: "prompt",
          message,
          toolNames,
          ...(piImages?.length ? { images: piImages } : {}),
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
        });
        if (!(result as { success?: boolean }).success) throw new Error("Failed to create agent session");
        const realId = (result as { sessionId: string }).sessionId;
        sessionIdRef.current = realId;
        
        // Immediate sync to global context so that when AppShell triggers a re-render
        // with the new session ID, the new mount will see the current local state.
        updateSession(realId, {
          data, messages: [...messages, userMsg], agentRunning: true, streamState, thinkingLevel, toolPreset,
          contextUsage, systemPrompt, isCompacting, agentPhase: { kind: "waiting_model" }, activeLeafId, entryIds,
        });

        connectEvents(realId);
        onSessionCreated?.({
          id: realId,
          path: "",
          cwd: newSessionCwd,
          name: undefined,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 1,
          firstMessage: message,
        });
      } else if (session) {
        connectEvents(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, toolPreset, thinkingLevel, session, agentRunning, connectEvents, onSessionCreated, setMessages, setAgentRunning, setAgentPhase]);

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  const handleFork = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext, setActiveLeafId]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext, setActiveLeafId]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [isNew, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession, setIsCompacting]);

  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setMessages((prev) => [...prev, { role: "user", content: `[steer] ${message}`, timestamp: Date.now() } as AgentMessage]);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, [setMessages]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setMessages((prev) => [...prev, { role: "user", content: message, timestamp: Date.now() } as AgentMessage]);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to follow up:", e);
    }
  }, [setMessages]);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [setThinkingLevel]);

  const handleToolPresetChange = useCallback(async (preset: "none" | "default" | "full") => {
    const { PRESET_NONE, PRESET_DEFAULT, PRESET_FULL } = await import("@/components/ToolPanel");
    const toolNames = preset === "none" ? PRESET_NONE : preset === "default" ? PRESET_DEFAULT : PRESET_FULL;
    setToolPresetState(preset);
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    container.scrollTo({ top: elAbsTop - 16, behavior: "smooth" });
  }, []);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    if (!agentRunningRef.current) return;
    if (Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    if (Date.now() > userScrollIntentUntilRef.current) return;
    completionScrollAllowedRef.current = false;
  }, []);

  // Load session on mount
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      // If we don't have global state, or if the global state doesn't have data, load it
      if (!globalState || !globalState.data) {
        // If we already have messages locally (e.g. from handleSend in the same hook instance), 
        // don't show full-screen loading.
        const shouldShowLoading = messages.length === 0;
        loadSession(session.id, shouldShowLoading, true).then((agentState) => {
          if (agentState?.running) {
            loadTools(session.id);
            connectEvents(session.id); // connectEvents will fetch latest streaming state
            
            // Ensure local state reflects that it is running
            setAgentRunning(true);
            agentRunningRef.current = true;
            
            // Only start stream and waiting_model if we don't already have streaming state
            // from the loadSession call we just made
            if (!agentState?.state?.isStreaming) {
               setAgentPhase({ kind: "waiting_model" });
               dispatch({ type: "start" });
            } else if (agentState?.state?.isStreaming && (agentState.state as any).streamingMessage) {
               dispatch({ type: "start" });
               dispatch({ type: "update", message: normalizeToolCalls((agentState.state as any).streamingMessage as AgentMessage) });
            }
          }
          if (agentState?.state) {
            if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
            if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
            if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
            if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
          }
        });
      } else {
        // We have global state, sync latest session data from disk and connect events
        loadSession(session.id, false, true).then((agentState) => {
          if (agentState?.running || globalState.agentRunning) {
            connectEvents(session.id);
            setAgentRunning(true);
            agentRunningRef.current = true;
          } else {
            // Only stop if both backend and global state say it's stopped
            setAgentRunning(false);
            agentRunningRef.current = false;
            setAgentPhase(null);
            dispatch({ type: "end" });
          }
        });
      }
    }
    return () => {
      if (typeof window !== "undefined" && ('electron' in window)) {
        if (eventSourceRef.current) {
          ((eventSourceRef.current as unknown) as () => void)();
          eventSourceRef.current = null;
        }
      } else {
        if (eventSourceRef.current) {
          (eventSourceRef.current as EventSource).close();
          eventSourceRef.current = null;
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]); // Re-run when sessionId changes

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
      window.removeEventListener("pointerdown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange, markUserScrollIntent]);

  useEffect(() => {
    if (messages.length > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (!agentRunningRef.current && completionScrollAllowedRef.current) {
        scrollToBottom("smooth");
      }
    }
  }, [messages.length, agentRunning, scrollToBottom, scrollUserMsgToTop]);

  // Load model list
  useEffect(() => {
    // 桌面端使用 IPC 调用
    window.electron.invoke('get-models').then(((d: unknown) => {
      const data = d as { models: Record<string, string>; thinkingLevels?: Record<string, string[]>; thinkingLevelMaps?: Record<string, Record<string, string | null>>; modelList?: { id: string; name: string; provider: string }[]; defaultModel?: { provider: string; modelId: string } };
      setModelNames(data.models);
      if (data.thinkingLevels) setModelThinkingLevels(data.thinkingLevels);
      if (data.thinkingLevelMaps) setModelThinkingLevelMaps(data.thinkingLevelMaps);
      if (data.modelList) {
        setModelList(data.modelList);
        if (isNew && data.modelList.length > 0) {
          const def = data.defaultModel;
          const match = def && data.modelList.find((m: { id: string, provider: string }) => m.id === def.modelId && m.provider === def.provider);
          const selected = match
            ? { provider: match.provider, modelId: match.id }
            : { provider: data.modelList[0].provider, modelId: data.modelList[0].id };
          setNewSessionModel(selected);
        }
      }
    }) as (value: unknown) => void).catch(() => {});
  }, [isNew, modelsRefreshKey, setNewSessionModel]);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(t);
  }, [compactError]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, sessionStats,
    agentPhase,
    isNew,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handleAbortCompaction,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    // Subscriptions
    handleAgentEventRef,
  };
}
