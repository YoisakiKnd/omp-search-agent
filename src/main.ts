import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Bot } from "grammy";
import { loadConfig } from "./config.ts";
import { Store } from "./database.ts";
import { createLogger } from "./logger.ts";
import { OmpRuntime } from "./omp.ts";
import { parseUpdate } from "./parser.ts";
import { WorkerPool } from "./worker.ts";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
await mkdir(config.DATA_DIR, { recursive: true });
const lockPath = join(config.DATA_DIR, "bot.lock");
async function acquireLock() {
  try {
    const handle = await open(lockPath, "wx"); await handle.writeFile(String(process.pid)); return handle;
  } catch {
    const previous = Number(await readFile(lockPath,"utf8").catch(()=>"0"));
    let alive = false;
    if (previous > 0) try { process.kill(previous,0); alive = true; } catch {}
    if (alive) throw new Error(`Another bot instance is running with PID ${previous}`);
    await unlink(lockPath).catch(()=>{});
    const handle = await open(lockPath,"wx"); await handle.writeFile(String(process.pid)); return handle;
  }
}
const lock = await acquireLock();

const store = new Store(config);
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
await bot.api.deleteWebhook({ drop_pending_updates: false });
const me = await bot.api.getMe();
if (!me.username) throw new Error("Telegram bot has no username");
const omp = await OmpRuntime.create(config, logger);
const workers = new WorkerPool(config, store, bot.api, me.id, me.username, omp, logger);

bot.use(async (ctx) => {
  const result = parseUpdate(ctx.update, me.id, me.username!, config.TELEGRAM_DISCUSSION_GROUP_ID, store);
  if (result.kind === "ignore") return;
  if (result.kind === "invalid") {
    await ctx.api.sendMessage(result.chatId,result.reason,{reply_parameters:{message_id:result.replyTo}}); return;
  }
  const queued = store.enqueue(ctx.update.update_id,result.request.userId,result.request.chatId,JSON.stringify(ctx.update));
  if (queued === "full") await ctx.api.sendMessage(result.request.chatId,"当前搜索队列已满，请稍后再试。",{reply_parameters:{message_id:result.request.inputMessageId}});
  if (queued === "busy") await ctx.api.sendMessage(result.request.chatId,"你已有一个待处理的请求，请等待完成后再试。",{reply_parameters:{message_id:result.request.inputMessageId}});
});

workers.start();
const heartbeat = setInterval(async () => {
  store.heartbeat("polling");
  await writeFile(join(config.DATA_DIR,"heartbeat.json"),JSON.stringify({at:Date.now()})).catch(()=>{});
}, 10_000);
const cleanup = setInterval(() => workers.cleanup().catch(error => logger.error("cleanup failed",{error:String(error)})), 60 * 60_000);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return; shuttingDown = true;
  logger.info("shutting down", { signal });
  clearInterval(heartbeat); clearInterval(cleanup); await bot.stop();
  await Promise.race([workers.stop(), Bun.sleep(config.SHUTDOWN_GRACE_MS)]);
  store.close(); await lock.close(); await Bun.file(lockPath).delete().catch(()=>{});
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

logger.info("starting Telegram long polling", { username: me.username, model: config.OMP_MODEL });
await bot.start({ allowed_updates: ["message"], timeout: config.POLLING_TIMEOUT_SECONDS, limit: config.POLLING_LIMIT, onStart: () => logger.info("polling started") });
