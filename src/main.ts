import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { loadConfig } from "./config.ts";
import { Store } from "./database.ts";
import { createLogger } from "./logger.ts";
import { OmpRuntime } from "./omp.ts";
import { parseAlbumUpdates, parseUpdate, type ParseResult } from "./parser.ts";
import type { ImageRef, StoredJobPayload } from "./types.ts";
import { WorkerPool } from "./worker.ts";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
await mkdir(config.DATA_DIR, { recursive: true });

const store = new Store(config);
const instanceOwner = randomUUID();
if (!store.acquireInstanceLease(instanceOwner, config.INSTANCE_LEASE_MS)) {
  store.close();
  throw new Error("Another bot instance holds the active database lease");
}

let bot: Bot | undefined;
let workers: WorkerPool | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let cleanup: ReturnType<typeof setInterval> | undefined;
let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
let telegramProbe: ReturnType<typeof setInterval> | undefined;
const albumTimers = new Map<string, ReturnType<typeof setTimeout>>();
let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: string) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logger.info("shutting down", { signal });
    if (heartbeat) clearInterval(heartbeat);
    if (cleanup) clearInterval(cleanup);
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    if (telegramProbe) clearInterval(telegramProbe);
    for (const timer of albumTimers.values()) clearTimeout(timer);
    albumTimers.clear();
    await bot?.stop().catch(() => {});
    if (workers) {
      const stopped = workers.stop();
      const graceful = await Promise.race([stopped.then(() => true), Bun.sleep(config.SHUTDOWN_GRACE_MS).then(() => false)]);
      if (!graceful) logger.warn("workers exceeded shutdown grace period; waiting for safe database close");
      await stopped;
    }
    store.releaseInstanceLease(instanceOwner);
    store.close();
  })();
  return shutdownPromise;
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  const me = await bot.api.getMe();
  if (!me.username) throw new Error("Telegram bot has no username");
  const omp = await OmpRuntime.create(config, logger);
  workers = new WorkerPool(config, store, bot.api, me.id, me.username, omp, logger);

  const handleParsed = async (update: Update, result: ParseResult, albumImageRefs?: ImageRef[], stillCurrent?: () => boolean): Promise<"consumed"|"deferred"> => {
    if (result.kind === "ignore") return "consumed";
    if (result.kind === "invalid") {
      await bot!.api.sendMessage(result.chatId,result.reason,{reply_parameters:{message_id:result.replyTo}}); return "consumed";
    }
    if (!await workers!.authorized(result.request.userId)) {
      await bot!.api.sendMessage(result.request.chatId,"只有频道成员可以使用此 Bot。",{reply_parameters:{message_id:result.request.inputMessageId}}); return "consumed";
    }
    if (stillCurrent && !stillCurrent()) return "deferred";
    if (!workers!.allowRequest(result.request.userId)) {
      await bot!.api.sendMessage(result.request.chatId,"请求过于频繁，请稍后再试。",{reply_parameters:{message_id:result.request.inputMessageId}}); return "consumed";
    }
    const payload: StoredJobPayload = { update, albumImageRefs };
    const queued = store.enqueue(update.update_id,result.request.userId,result.request.chatId,JSON.stringify(payload));
    if (queued === "full") await bot!.api.sendMessage(result.request.chatId,"当前搜索队列已满，请稍后再试。",{reply_parameters:{message_id:result.request.inputMessageId}});
    if (queued === "busy") await bot!.api.sendMessage(result.request.chatId,"你已有一个待处理的请求，请等待完成后再试。",{reply_parameters:{message_id:result.request.inputMessageId}});
    return "consumed";
  };

  const flushAlbum = async (groupId: string) => {
    albumTimers.delete(groupId);
    const snapshot = store.albumSnapshot(groupId);
    if (!snapshot) return;
    const updates = snapshot.updates as Update[];
    const selected = parseAlbumUpdates(updates, me.id, me.username!, config.TELEGRAM_DISCUSSION_GROUP_ID, store);
    if (selected) {
      const outcome = await handleParsed(selected.update, selected.result, selected.imageRefs, () => store.albumSnapshot(groupId)?.raw === snapshot.raw);
      if (outcome === "deferred") { scheduleAlbum(groupId); return; }
    }
    store.deleteAlbum(groupId, snapshot.raw);
  };

  const scheduleAlbum = (groupId: string, delayMs = 1_000) => {
    const previous = albumTimers.get(groupId);
    if (previous) clearTimeout(previous);
    albumTimers.set(groupId, setTimeout(() => {
      void flushAlbum(groupId).catch((error) => {
        logger.error("album flush failed", { error:String(error) });
        if (!shutdownPromise) scheduleAlbum(groupId, 5_000);
      });
    }, delayMs));
  };

  bot.use(async (ctx) => {
    const groupId = ctx.update.message?.media_group_id;
    if (groupId) {
      store.appendAlbumUpdate(groupId, JSON.stringify(ctx.update));
      scheduleAlbum(groupId);
      return;
    }
    const result = parseUpdate(ctx.update, me.id, me.username!, config.TELEGRAM_DISCUSSION_GROUP_ID, store);
    await handleParsed(ctx.update, result);
  });

  for (const groupId of store.pendingAlbumIds()) scheduleAlbum(groupId);

  workers.start();
  let telegramAt = Date.now();
  heartbeat = setInterval(async () => {
    store.heartbeat("polling");
    await writeFile(join(config.DATA_DIR,"heartbeat.json"),JSON.stringify({
      processAt:Date.now(), telegramAt, workerAt:workers!.heartbeatAt(),
    })).catch(()=>{});
  }, 10_000);
  telegramProbe = setInterval(() => {
    void bot!.api.getMe()
      .then(() => { telegramAt = Date.now(); })
      .catch((error) => logger.warn("Telegram health probe failed", { error:String(error) }));
  }, 30_000);
  cleanup = setInterval(() => workers?.cleanup().catch(error => logger.error("cleanup failed",{error:String(error)})), 60 * 60_000);
  leaseHeartbeat = setInterval(() => {
    if (!store.renewInstanceLease(instanceOwner)) {
      logger.error("instance lease lost");
      void shutdown("lease-lost");
    }
  }, Math.max(10_000, Math.floor(config.INSTANCE_LEASE_MS / 3)));

  logger.info("starting Telegram long polling", { username: me.username, model: config.OMP_MODEL });
  await bot.start({ allowed_updates: ["message"], timeout: config.POLLING_TIMEOUT_SECONDS, limit: config.POLLING_LIMIT, onStart: () => logger.info("polling started") });
} finally {
  await shutdown("main-exit");
}
