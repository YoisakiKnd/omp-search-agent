import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/database.ts";
import { WorkerPool } from "../src/worker.ts";
import type { StoredJobPayload } from "../src/types.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });

describe("WorkerPool delivery", () => {
  test("reuses the saved answer and already-sent pages after a partial Telegram failure", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".tmp-worker-")); dirs.push(dir);
    const page = join(dir,"page.png"); writeFileSync(page, "x");
    const config = {
      DATA_DIR:dir, QUEUE_LIMIT:5, QUERY_TIMEOUT_MS:30_000, CONTEXT_MAX_TURNS:6,
      CONTEXT_TTL_HOURS:24, CONTEXT_MAX_CHARS:16_000, JOB_RETENTION_DAYS:7,
      MAX_IMAGES_PER_QUERY:4, MAX_TOTAL_IMAGE_BYTES:20_000_000,
      TELEGRAM_DISCUSSION_GROUP_ID:-100, TELEGRAM_CHANNEL_ID:undefined,
      ORPHAN_MEDIA_GRACE_HOURS:24,
    } as any;
    const store = new Store(config);
    const update: any = { update_id:1, message:{message_id:2,date:1,chat:{id:-100,type:"supergroup"},from:{id:7,is_bot:false,first_name:"u"},text:"@SearchBot test",entities:[{type:"mention",offset:0,length:10}]} };
    const payload: StoredJobPayload = {update};
    store.enqueue(1,7,-100,JSON.stringify(payload));

    let askCount = 0, photoCount = 0, sourceAttempts = 0, failSource = true;
    const api = {
      sendMessage: async (_chatId:number, _text:string, options:any) => {
        if (!options?.parse_mode) return {message_id:100};
        sourceAttempts++;
        if (failSource) { failSource = false; throw new Error("temporary send failure"); }
        return {message_id:300};
      },
      sendPhoto: async () => { photoCount++; return {message_id:200}; },
      deleteMessage: async () => true,
    } as any;
    const omp = { ask: async () => { askCount++; return "Answer\n\n## 参考来源\n- [Example](https://example.com/source)"; } } as any;
    const logger = {debug(){},info(){},warn(){},error(){}} as any;
    const renderer = {render: async () => ({paths:[page],cleanup:async()=>{}})};
    const worker = new WorkerPool(config,store,api,99,"SearchBot",omp,logger,renderer);
    const run = (job:any) => (worker as any).run(job) as Promise<void>;

    const first = store.claim("owner-a")!;
    await expect(run(first)).rejects.toThrow("temporary send failure");
    expect(store.fail(first.id,"owner-a","temporary send failure",true)).toBe(true);
    const second = store.claim("owner-b")!;
    await run(second);
    expect(store.complete(second.id,"owner-b")).toBe(true);

    expect(askCount).toBe(1);
    expect(photoCount).toBe(1);
    expect(sourceAttempts).toBe(2);
    expect(store.jobOutputs(second.id).map((item) => item.message_id)).toEqual([200,300]);
    expect((store.db.query("SELECT conversation_node_id FROM jobs WHERE id=?").get(second.id) as {conversation_node_id:number}).conversation_node_id).toBeGreaterThan(0);
    store.close();
  });
});
