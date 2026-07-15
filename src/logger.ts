import type { Config } from "./config.ts";

const ranks = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof ranks;

export function createLogger(level: Config["LOG_LEVEL"]) {
  const write = (kind: LogLevel, message: string, fields: Record<string, unknown> = {}) => {
    if (ranks[kind] < ranks[level]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: kind, message, ...fields });
    (kind === "error" ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => write("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => write("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => write("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => write("error", m, f),
  };
}
export type Logger = ReturnType<typeof createLogger>;
