"use client";

import React, { createContext, useContext, ReactNode, useCallback, useRef, useState, useEffect } from "react";
import type { AgentMessage, SessionInfo } from "@/lib/types";

export interface SessionState {
  data: any | null; 
  messages: AgentMessage[];
  agentRunning: boolean;
  streamState: {
    isStreaming: boolean;
    streamingMessage: Partial<AgentMessage> | null;
  };
  thinkingLevel: any;
  toolPreset: "none" | "default" | "full";
  contextUsage: any | null;
  systemPrompt: string | null;
  isCompacting: boolean;
  agentPhase: any | null;
  activeLeafId: string | null;
  entryIds: string[];
}

interface SessionContextType {
  updateSession: (sessionId: string, updates: Partial<SessionState>) => void;
  getSession: (sessionId: string) => SessionState | undefined;
  sessions: SessionInfo[];
  refreshSessions: (showLoading?: boolean) => Promise<void>;
  loadingSessions: boolean;
  sessionsError: string | null;
  runningSessions: Record<string, boolean>;
  completedSessions: Record<string, number>;
}

const SessionContext = createContext<SessionContextType | undefined>(undefined);

const defaultSessionState: SessionState = {
  data: null,
  messages: [],
  agentRunning: false,
  streamState: { isStreaming: false, streamingMessage: null },
  thinkingLevel: "auto",
  toolPreset: "default",
  contextUsage: null,
  systemPrompt: null,
  isCompacting: false,
  agentPhase: null,
  activeLeafId: null,
  entryIds: [],
};

export function SessionProvider({ children }: { children: ReactNode }) {
  // Use a ref to store session data so updates don't trigger re-renders of the whole app
  const sessionsRef = useRef<Record<string, SessionState>>({});
  
  // Session list management (响应式的，因为侧边栏和标签页需要它)
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [runningSessions, setRunningSessions] = useState<Record<string, boolean>>({});
  const [completedSessions, setCompletedSessions] = useState<Record<string, number>>({});
  const runningSessionsRef = useRef<Record<string, boolean>>({});

  const setRunningSessionStatus = useCallback((updater: (prev: Record<string, boolean>) => Record<string, boolean>) => {
    setRunningSessions(prev => {
      const next = updater(prev);
      runningSessionsRef.current = next;
      return next;
    });
  }, []);

  const refreshSessions = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) setLoadingSessions(true);
      const data = await window.electron.invoke('get-sessions');
      const sessionList = (data as { sessions: SessionInfo[] }).sessions;
      setSessions(sessionList);
      
      const previousRunningSessions = runningSessionsRef.current;
      const completedAt = Date.now();
      const completedUpdates: Record<string, number | null> = {};
      const nextRunningSessions = { ...previousRunningSessions };

      // Sync running status from the loaded list
      sessionList.forEach(s => {
        if (s.running !== undefined) {
          if (previousRunningSessions[s.id] === true && s.running === false) {
            completedUpdates[s.id] = completedAt;
          } else if (s.running === true) {
            completedUpdates[s.id] = null;
          }
          nextRunningSessions[s.id] = s.running;
        }
      });
      setRunningSessionStatus(() => nextRunningSessions);
      if (Object.keys(completedUpdates).length > 0) {
        setCompletedSessions(prev => {
          const next = { ...prev };
          for (const [sessionId, completedAtOrNull] of Object.entries(completedUpdates)) {
            if (completedAtOrNull === null) delete next[sessionId];
            else next[sessionId] = completedAtOrNull;
          }
          return next;
        });
      }
      
      setSessionsError(null);
    } catch (e) {
      setSessionsError(String(e));
    } finally {
      if (showLoading) setLoadingSessions(false);
    }
  }, [setRunningSessionStatus]);

  // Listen for live running status updates
  useEffect(() => {
    const handleRunningUpdate = (e: Event) => {
      const { sessionId, running, completedAt } = (e as CustomEvent).detail ?? {};
      if (!sessionId || typeof running !== "boolean") return;
      setRunningSessionStatus(prev => {
        if (prev[sessionId] === running) return prev;
        return { ...prev, [sessionId]: running };
      });
      if (running) {
        setCompletedSessions(prev => {
          if (!(sessionId in prev)) return prev;
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      } else if (typeof completedAt === "number") {
        setCompletedSessions(prev => ({ ...prev, [sessionId]: completedAt }));
      }
    };
    window.addEventListener("pi-session-running-status-update", handleRunningUpdate);
    return () => window.removeEventListener("pi-session-running-status-update", handleRunningUpdate);
  }, [setRunningSessionStatus]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const cutoff = Date.now() - 60000;
      setCompletedSessions(prev => {
        let changed = false;
        const next = { ...prev };
        for (const [sessionId, completedAt] of Object.entries(next)) {
          if (completedAt < cutoff) {
            delete next[sessionId];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  // Initial load and listen for changes
  useEffect(() => {
    refreshSessions(true);
    
    const cleanup = window.electron.on('sessions-changed', () => {
      refreshSessions(false);
    });
    return cleanup;
  }, [refreshSessions]);

  const updateSession = useCallback((sessionId: string, updates: Partial<SessionState>) => {
    const current = sessionsRef.current[sessionId] || defaultSessionState;
    sessionsRef.current[sessionId] = { ...current, ...updates };
    if (updates.agentRunning === undefined) return;

    setRunningSessionStatus(prev => {
      const previousRunning = prev[sessionId];
      if (previousRunning === updates.agentRunning) return prev;
      return { ...prev, [sessionId]: updates.agentRunning! };
    });
    if (updates.agentRunning) {
      setCompletedSessions(prev => {
        if (!(sessionId in prev)) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    } else {
      const wasRunning = current.agentRunning || current.streamState.isStreaming;
      if (wasRunning) {
        setCompletedSessions(prev => ({ ...prev, [sessionId]: Date.now() }));
      }
    }
  }, [setRunningSessionStatus]);

  const getSession = useCallback((sessionId: string) => {
    return sessionsRef.current[sessionId];
  }, []);

  return (
    <SessionContext.Provider value={{ 
      updateSession, 
      getSession, 
      sessions, 
      refreshSessions, 
      loadingSessions, 
      sessionsError,
      runningSessions,
      completedSessions
    }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useGlobalSessionContext() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useGlobalSessionContext must be used within a SessionProvider");
  }
  return context;
}
