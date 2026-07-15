import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/database.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });

describe("Store", () => {
  test("persists jobs, deduplicates updates and enforces one job per user", () => {
    const dir = mkdtempSync(join(process.cwd(), ".tmp-test-")); dirs.push(dir);
    const store = new Store({ DATA_DIR:dir, QUEUE_LIMIT:5, QUERY_TIMEOUT_MS:1000, CONTEXT_MAX_TURNS:6, CONTEXT_TTL_HOURS:24 } as any);
    expect(store.enqueue(1,10,-100,"{}")).toBe("queued");
    expect(store.enqueue(1,10,-100,"{}")).toBe("duplicate");
    expect(store.enqueue(2,10,-100,"{}")).toBe("busy");
    expect(store.claim()?.status).toBe("running");
    store.close();
  });
});
