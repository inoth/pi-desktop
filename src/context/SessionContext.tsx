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

  const refreshSessions = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) setLoadingSessions(true);
      const data = await window.electron.invoke('get-sessions');
      const sessionList = (data as { sessions: SessionInfo[] }).sessions;
      setSessions(sessionList);
      
      // Sync running status from the loaded list
      setRunningSessions(prev => {
        const next = { ...prev };
        sessionList.forEach(s => {
          if (s.running !== undefined) {
            next[s.id] = s.running;
          }
        });
        return next;
      });
      
      setSessionsError(null);
    } catch (e) {
      setSessionsError(String(e));
    } finally {
      if (showLoading) setLoadingSessions(false);
    }
  }, []);

  // Listen for live running status updates
  useEffect(() => {
    const handleRunningUpdate = (e: Event) => {
      const { sessionId, running } = (e as CustomEvent).detail;
      setRunningSessions(prev => {
        if (prev[sessionId] === running) return prev;
        return { ...prev, [sessionId]: running };
      });
    };
    window.addEventListener("pi-session-running-status-update", handleRunningUpdate);
    return () => window.removeEventListener("pi-session-running-status-update", handleRunningUpdate);
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
  }, []);

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
      runningSessions
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
