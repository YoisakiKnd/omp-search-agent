import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Store } from "../src/database.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });

describe("Store", () => {
  const config = (dir: string) => ({
    DATA_DIR:dir, QUEUE_LIMIT:5, QUERY_TIMEOUT_MS:1000, CONTEXT_MAX_TURNS:6,
    CONTEXT_TTL_HOURS:24, JOB_RETENTION_DAYS:7,
  } as any);

  test("persists jobs, deduplicates updates and enforces one job per user", () => {
    const dir = mkdtempSync(join(process.cwd(), ".tmp-test-")); dirs.push(dir);
    const store = new Store(config(dir));
    expect(store.enqueue(1,10,-100,"{}")).toBe("queued");
    expect(store.enqueue(1,10,-100,"{}")).toBe("duplicate");
    expect(store.enqueue(2,10,-100,"{}")).toBe("busy");
    expect(store.claim("worker-a")?.status).toBe("running");
    store.close();
  });

  test("uses an expiring instance lease instead of process ids", () => {
    const dir = mkdtempSync(join(process.cwd(), ".tmp-test-")); dirs.push(dir);
    const first = new Store(config(dir));
    const second = new Store(config(dir));
    expect(first.acquireInstanceLease("instance-a", 90_000)).toBe(true);
    expect(second.acquireInstanceLease("instance-b", 90_000)).toBe(false);
    expect(first.renewInstanceLease("instance-a")).toBe(true);
    first.releaseInstanceLease("instance-a");
    expect(second.acquireInstanceLease("instance-b", 90_000)).toBe(true);
    first.close(); second.close();
  });

  test("only the lease owner can persist and complete a job", () => {
    const dir = mkdtempSync(join(process.cwd(), ".tmp-test-")); dirs.push(dir);
    const store = new Store(config(dir));
    store.enqueue(1,10,-100,"{\"message\":{}}");
    const job = store.claim("worker-a")!;
    expect(store.setJobResult(job.id,"worker-b","answer")).toBe(false);
    expect(store.setJobResult(job.id,"worker-a","answer")).toBe(true);
    expect(store.recordJobOutput(job.id,"worker-a","page",0,123)).toBe(true);
    expect(store.jobOutputs(job.id)).toEqual([{kind:"page",position:0,message_id:123}]);
    expect(store.complete(job.id,"worker-b")).toBe(false);
    const nodeId = store.addConversation({
      jobId:job.id, owner:"worker-a", chatId:-100, inputMessageId:9, userId:10,
      question:"q", answer:"a", sources:[], outputIds:[123], media:[],
    });
    expect(Number(nodeId)).toBeGreaterThan(0);
    expect(store.complete(job.id,"worker-a")).toBe(true);
    const row = store.db.query("SELECT payload,result,conversation_node_id FROM jobs WHERE id=?").get(job.id) as {payload:string;result:string|null;conversation_node_id:number};
    expect(row).toEqual({payload:"{}",result:null,conversation_node_id:Number(nodeId)});
    store.close();
  });

  test("persists media-group updates until the exact snapshot is consumed", () => {
    const dir = mkdtempSync(join(process.cwd(), ".tmp-test-")); dirs.push(dir);
    const store = new Store(config(dir));
    store.appendAlbumUpdate("album-1", JSON.stringify({update_id:1}));
    const first = store.albumSnapshot("album-1")!;
    expect(first.updates).toEqual([{update_id:1}]);
    store.appendAlbumUpdate("album-1", JSON.stringify({update_id:2}));
    store.deleteAlbum("album-1", first.raw);
    expect(store.albumSnapshot("album-1")?.updates).toEqual([{update_id:1},{update_id:2}]);
    const latest = store.albumSnapshot("album-1")!;
    store.deleteAlbum("album-1", latest.raw);
    expect(store.pendingAlbumIds()).toEqual([]);
    store.close();
  });

  test("migrates the previous jobs schema without discarding queued data", () => {
    const dir = mkdtempSync(join(process.cwd(), ".tmp-test-")); dirs.push(dir);
    const legacy = new Database(join(dir,"bot.sqlite"), {create:true});
    legacy.exec(`CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, update_id INTEGER NOT NULL UNIQUE,
      user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER, placeholder_message_id INTEGER, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`);
    legacy.query("INSERT INTO jobs(update_id,user_id,chat_id,payload,created_at,updated_at) VALUES(1,2,3,'{}',4,4)").run();
    legacy.close();
    const store = new Store(config(dir));
    try {
      const columns = store.db.query("PRAGMA table_info(jobs)").all() as Array<{name:string}>;
      const names = columns.map((column) => column.name);
      expect(names).toContain("lease_owner");
      expect(names).toContain("result");
      expect(names).toContain("conversation_node_id");
      expect((store.db.query("SELECT count(*) AS n FROM jobs").get() as {n:number}).n).toBe(1);
    } finally { store.close(); }
  });
});
