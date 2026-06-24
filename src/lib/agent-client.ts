// Client-side helper for agent IPC

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const result = await window.electron.invoke('agent-send', sessionId, command);
  if (!result.success) throw new Error(result.error || "Failed");
  return result.data as T;
}
