export interface HeartbeatState {
  processAt: number;
  telegramAt: number;
  workerAt: number;
}

export function assertHealthyHeartbeat(value: unknown, now: number, staleMs: number): asserts value is HeartbeatState {
  if (!value || typeof value !== "object") throw new Error("heartbeat payload is invalid");
  const heartbeat = value as Record<string, unknown>;
  for (const field of ["processAt", "telegramAt", "workerAt"] as const) {
    const timestamp = heartbeat[field];
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp > now + 5_000 || now - timestamp > staleMs) {
      throw new Error(`${field} heartbeat is stale or invalid`);
    }
  }
}
