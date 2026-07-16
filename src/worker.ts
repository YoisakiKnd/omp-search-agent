import { readdir, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { InputFile, type Api } from "grammy";
import type { ChatMember, Update } from "grammy/types";
import type { Config } from "./config.ts";
import type { Store } from "./database.ts";
import { extractSourceLinks, stripSourceUrls } from "./format.ts";
import type { Logger } from "./logger.ts";
import { loadPrepared, prepareImage } from "./media.ts";
import type { OmpRuntime } from "./omp.ts";
import { parseUpdate } from "./parser.ts";
import { RateLimiter } from "./rate-limit.ts";
import { buildUserPrompt } from "./prompt.ts";
import type { JobRow, PreparedImage, StoredJobPayload } from "./types.ts";
import { TypstRenderer } from "./typst.ts";

class PermanentError extends Error {}

function isMember(member: ChatMember) {
  return member.status === "creator" || member.status === "administrator" || member.status === "member" || (member.status === "restricted" && member.is_member);
}

export class WorkerPool {
  private stopping = false;
  private tasks = new Set<Promise<void>>();
  private limiter = new RateLimiter(5, 10 * 60_000);
  private membershipCache = new Map<number, { allowed: boolean; expires: number }>();
  private renderer: Pick<TypstRenderer,"render">;
  private abortController = new AbortController();
  private lastHeartbeat = Date.now();

  constructor(private config: Config, private store: Store, private api: Api, private botId: number, private username: string, private omp: OmpRuntime, private logger: Logger, renderer?: Pick<TypstRenderer,"render">) {
    this.renderer = renderer ?? new TypstRenderer(config);
  }

  start() {
    for (let i = 0; i < this.config.GLOBAL_CONCURRENCY; i++) {
      const task = this.loop(i).finally(() => this.tasks.delete(task)); this.tasks.add(task);
    }
  }
  async stop() {
    this.stopping = true;
    this.abortController.abort();
    await Promise.allSettled(this.tasks);
  }
  heartbeatAt() { return this.lastHeartbeat; }

  private async loop(slot: number) {
    const owner = `${slot}:${randomUUID()}`;
    while (!this.stopping) {
      this.lastHeartbeat = Date.now();
      this.store.heartbeat(`worker-${slot}`);
      const job = this.store.claim(owner);
      if (!job) { await Bun.sleep(400); continue; }
      const started = Date.now();
      let leaseLost = false;
      const renewEvery = Math.max(5_000, Math.min(30_000, Math.floor(this.config.QUERY_TIMEOUT_MS / 3)));
      const renew = setInterval(() => {
        this.lastHeartbeat = Date.now();
        if (!this.store.renewJobLease(job.id, owner)) leaseLost = true;
      }, renewEvery);
      try {
        await this.run(job);
        if (leaseLost || !this.store.complete(job.id, owner)) {
          throw new Error("job lease was lost before completion");
        }
        this.logger.info("job completed", { jobId: job.id, updateId: job.update_id, durationMs: Date.now()-started });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retry = !(error instanceof PermanentError) && job.attempts < 2;
        const owned = !leaseLost && this.store.fail(job.id, owner, message, retry);
        this.logger.error("job failed", { jobId: job.id, retry, error: message });
        if (owned && !retry && !this.stopping) await this.showError(job, message);
      } finally {
        clearInterval(renew);
      }
    }
  }

  async authorized(userId: number) {
    if (this.config.TELEGRAM_CHANNEL_ID === undefined) return true;
    const cached = this.membershipCache.get(userId);
    if (cached && cached.expires > Date.now()) return cached.allowed;
    let allowed = false;
    try { allowed = isMember(await this.api.getChatMember(this.config.TELEGRAM_CHANNEL_ID, userId)); } catch { allowed = false; }
    this.membershipCache.set(userId, { allowed, expires: Date.now()+60_000 });
    return allowed;
  }

  allowRequest(userId: number) { return this.limiter.allow(userId); }

  private async run(job: JobRow) {
    if (job.conversation_node_id) {
      if (job.placeholder_message_id) await this.api.deleteMessage(job.chat_id, job.placeholder_message_id).catch(()=>{});
      return;
    }
    const decoded = JSON.parse(job.payload) as Update | StoredJobPayload;
    const update = "update" in decoded ? decoded.update : decoded;
    const parsed = parseUpdate(update, this.botId, this.username, this.config.TELEGRAM_DISCUSSION_GROUP_ID, this.store);
    if (parsed.kind !== "request") throw new PermanentError(parsed.kind === "invalid" ? parsed.reason : "消息已不可处理");
    const req = parsed.request;
    if ("update" in decoded && decoded.albumImageRefs?.length) {
      req.imageRefs = [...decoded.albumImageRefs, ...req.imageRefs]
        .filter((image, index, all) => all.findIndex((candidate) => candidate.uniqueId === image.uniqueId) === index);
    }
    if (!await this.authorized(req.userId)) throw new PermanentError("只有频道成员可以使用此 Bot。");

    let placeholder = job.placeholder_message_id;
    if (!placeholder) {
      const sent = await this.api.sendMessage(req.chatId, req.imageRefs.length ? "正在分析图片并搜索…" : "正在搜索…", { reply_parameters: { message_id: req.inputMessageId } });
      placeholder = sent.message_id; this.store.setPlaceholder(job.id, job.lease_owner!, placeholder);
    }

    const prepared: PreparedImage[] = [];
    let totalImageBytes = 0;
    const refs = req.imageRefs.slice(0, this.config.MAX_IMAGES_PER_QUERY);
    for (const ref of refs) {
      const image = await prepareImage(this.api, ref, this.config, this.config.MAX_TOTAL_IMAGE_BYTES-totalImageBytes);
      totalImageBytes += image.sourceBytes;
      if (!prepared.some(x => x.hash === image.hash)) prepared.push(image);
    }
    if (req.parentNodeId && prepared.length < this.config.MAX_IMAGES_PER_QUERY) {
      const history = this.store.recentMedia(req.parentNodeId, this.config.MAX_IMAGES_PER_QUERY-prepared.length, req.userId);
      for (const item of history) {
        if (prepared.some(x => x.hash === item.hash) || totalImageBytes+item.bytes > this.config.MAX_TOTAL_IMAGE_BYTES) continue;
        prepared.push(await loadPrepared(item.path,item.hash,item.mime_type,item.bytes)); totalImageBytes += item.bytes;
      }
    }

    const history = req.parentNodeId ? this.store.conversationPath(req.parentNodeId, req.userId) : [];
    const prompt = buildUserPrompt(history, req.quotedText, req.question, this.config.CONTEXT_MAX_CHARS);
    const answer = job.result ?? await this.omp.ask(prompt, prepared, this.abortController.signal);
    if (!job.result && !this.store.setJobResult(job.id, job.lease_owner!, answer)) {
      throw new Error("job lease was lost before result persistence");
    }
    const sourceLinks = extractSourceLinks(answer);
    const sources = sourceLinks.map(source=>source.url);
    const body = stripSourceUrls(answer);
    const rendered = await this.renderer.render(body);
    const recorded = new Map(this.store.jobOutputs(job.id).map((item) => [`${item.kind}:${item.position}`, item.message_id]));
    const outputIds: number[] = [];
    try {
      for (const [index, path] of rendered.paths.entries()) {
        const existing = recorded.get(`page:${index}`);
        if (existing) { outputIds.push(existing); continue; }
        const sent = await this.api.sendPhoto(req.chatId, new InputFile(path), { reply_parameters: { message_id:req.inputMessageId } });
        if (!this.store.recordJobOutput(job.id, job.lease_owner!, "page", index, sent.message_id)) throw new Error("job lease was lost while recording output");
        outputIds.push(sent.message_id);
      }
      if (sourceLinks.length) {
        const batches: string[] = [];
        for (const [index,source] of sourceLinks.entries()) {
          const href = escapeHtml(source.url).replaceAll('"',"&quot;");
          const line = `<a href="${href}">${index+1}. ${escapeHtml(source.label)}</a>`;
          const last = batches.at(-1);
          if (!last || last.length + line.length + 1 > 3900) batches.push(line);
          else batches[batches.length-1] = `${last}\n${line}`;
        }
        for (const [index, batch] of batches.entries()) {
          const existing = recorded.get(`source:${index}`);
          if (existing) { outputIds.push(existing); continue; }
          const sent = await this.api.sendMessage(req.chatId, batch, {
            parse_mode:"HTML", link_preview_options:{is_disabled:true}, reply_parameters:{message_id:req.inputMessageId},
          });
          if (!this.store.recordJobOutput(job.id, job.lease_owner!, "source", index, sent.message_id)) throw new Error("job lease was lost while recording output");
          outputIds.push(sent.message_id);
        }
      }
      await this.api.deleteMessage(req.chatId, placeholder).catch(()=>{});
    } finally {
      await rendered.cleanup();
    }
    this.store.addConversation({ jobId:job.id,owner:job.lease_owner!,chatId:req.chatId,inputMessageId:req.inputMessageId,userId:req.userId,parentId:req.parentNodeId,question:req.question,quotedText:req.quotedText,answer,sources,outputIds,media:prepared.map(x=>({hash:x.hash,path:x.path,mimeType:x.mimeType,bytes:x.bytes})) });
  }

  private async showError(job: JobRow, message: string) {
    const safe = message.includes("图片") || message.includes("频道") || message.includes("频繁") || message.includes("上下文") ? message : "搜索暂时失败，请稍后重试。";
    try {
      if (job.placeholder_message_id) await this.api.editMessageText(job.chat_id,job.placeholder_message_id,safe);
      else {
        const decoded = JSON.parse(job.payload) as Update | StoredJobPayload;
        const update = "update" in decoded ? decoded.update : decoded;
        if (update.message) await this.api.sendMessage(job.chat_id,safe,{reply_parameters:{message_id:update.message.message_id}});
      }
    } catch {}
  }

  async cleanup() {
    for (const path of this.store.cleanup()) await unlink(path).catch(()=>{});
    const mediaDir = join(this.config.DATA_DIR, "media");
    const cutoff = Date.now() - this.config.ORPHAN_MEDIA_GRACE_HOURS * 3_600_000;
    for (const name of await readdir(mediaDir).catch(() => [] as string[])) {
      const path = join(mediaDir, name);
      if (this.store.isMediaPathKnown(path)) continue;
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && info.mtimeMs < cutoff) await unlink(path).catch(()=>{});
    }
  }
}

function escapeHtml(value: string) {
  return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}
