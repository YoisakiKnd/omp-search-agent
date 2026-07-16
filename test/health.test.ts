import { describe, expect, test } from "bun:test";
import { assertHealthyHeartbeat } from "../src/health.ts";

describe("health heartbeat", () => {
  test("requires process, Telegram and worker timestamps to all be fresh", () => {
    const now = 1_000_000;
    expect(() => assertHealthyHeartbeat({processAt:now,telegramAt:now-1_000,workerAt:now-2_000},now,10_000)).not.toThrow();
    expect(() => assertHealthyHeartbeat({processAt:now,telegramAt:now-20_000,workerAt:now},now,10_000)).toThrow("telegramAt");
    expect(() => assertHealthyHeartbeat({processAt:now,telegramAt:now},now,10_000)).toThrow("workerAt");
  });
});
