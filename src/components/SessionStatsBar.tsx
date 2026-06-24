"use client";

import { useState, useEffect } from "react";

export type SessionStatsData = { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null;
export type ContextUsageData = { percent: number | null; contextWindow: number; tokens: number | null } | null;

export function updateSessionStats(stats: SessionStatsData) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pi-session-stats", { detail: stats }));
  }
}

export function updateContextUsage(usage: ContextUsageData) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pi-context-usage", { detail: usage }));
  }
}

export function SessionStatsBar({ rightPanelOpen }: { rightPanelOpen: boolean }) {
  const [sessionStats, setSessionStats] = useState<SessionStatsData>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsageData>(null);

  useEffect(() => {
    const handleStats = (e: any) => setSessionStats(e.detail);
    const handleContext = (e: any) => setContextUsage(e.detail);

    window.addEventListener("pi-session-stats", handleStats);
    window.addEventListener("pi-context-usage", handleContext);

    return () => {
      window.removeEventListener("pi-session-stats", handleStats);
      window.removeEventListener("pi-context-usage", handleContext);
    };
  }, []);

  if (!sessionStats && !contextUsage) return null;

  const t = sessionStats?.tokens;
  const c = sessionStats?.cost ?? 0;
  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
  const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;

  let ctxColor = "var(--text-muted)";
  let ctxStr: string | null = null;
  if (contextUsage?.contextWindow) {
    const pct = contextUsage.percent;
    if (pct !== null && pct > 90) ctxColor = "#ef4444";
    else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
    ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
  }

  const tooltipParts: string[] = [];
  if (t) {
    tooltipParts.push(`in: ${t.input.toLocaleString()}`);
    tooltipParts.push(`out: ${t.output.toLocaleString()}`);
    tooltipParts.push(`cache read: ${t.cacheRead.toLocaleString()}`);
    tooltipParts.push(`cache write: ${t.cacheWrite.toLocaleString()}`);
    if (c > 0) tooltipParts.push(`cost: $${c.toFixed(4)}`);
  }
  if (contextUsage?.contextWindow) {
    const pct = contextUsage.percent;
    tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
  }
  const tooltip = tooltipParts.join("  |  ");

  return (
    <div
      title={tooltip}
      style={{
        marginLeft: "auto",
        display: "flex", alignItems: "center", gap: 10,
        paddingLeft: 12,
        paddingRight: rightPanelOpen ? 12 : 48,
        height: "100%",
        fontSize: 11, color: "var(--text-muted)",
        whiteSpace: "nowrap", cursor: "default",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {t && t.input > 0 && (
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
          </svg>
          {fmt(t.input)}
        </span>
      )}
      {t && t.output > 0 && (
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
          </svg>
          {fmt(t.output)}
        </span>
      )}
      {t && t.cacheRead > 0 && (
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
          </svg>
          {fmt(t.cacheRead)}
        </span>
      )}
      {costStr && (
        <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
          {costStr}
        </span>
      )}
      {ctxStr && (
        <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
          </svg>
          {ctxStr}
        </span>
      )}
    </div>
  );
}