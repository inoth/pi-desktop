// Client-side helper for agent IPC

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  if (typeof window !== "undefined" && ('electron' in window)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (window as any).electron.invoke('agent-send', sessionId, command);
    if (!result.success) throw new Error(result.error || "Failed");
    return result.data as T;
  }

  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
  };
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body.data as T;
}
