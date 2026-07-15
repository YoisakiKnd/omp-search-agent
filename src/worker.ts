import { unlink } from "node:fs/promises";
import type { Api } from "grammy";
import type { ChatMember, Update } from "grammy/types";
import type { Config } from "./config.ts";
import type { Store } from "./database.ts";
import { extractSources, splitText, toTelegramHtml } from "./format.ts";
import type { Logger } from "./logger.ts";
import { loadPrepared, prepareImage } from "./media.ts";
import type { OmpRuntime } from "./omp.ts";
import { parseUpdate } from "./parser.ts";
import { RateLimiter } from "./rate-limit.ts";
import type { JobRow, PreparedImage } from "./types.ts";

class PermanentError extends Error {}

function isMember(member: ChatMember) {
  return member.status === "creator" || member.status === "administrator" || member.status === "member" || (member.status === "restricted" && member.is_member);
}

export class WorkerPool {
  private stopping = false;
  private tasks = new Set<Promise<void>>();
  private limiter = new RateLimiter(5, 10 * 60_000);
  private membershipCache = new Map<number, { allowed: boolean; expires: number }>();

  constructor(private config: Config, private store: Store, private api: Api, private botId: number, private username: string, private omp: OmpRuntime, private logger: Logger) {}

  start() {
    for (let i = 0; i < this.config.GLOBAL_CONCURRENCY; i++) {
      const task = this.loop(i).finally(() => this.tasks.delete(task)); this.tasks.add(task);
    }
  }
  async stop() { this.stopping = true; await Promise.allSettled(this.tasks); }

  private async loop(slot: number) {
    while (!this.stopping) {
      this.store.heartbeat(`worker-${slot}`);
      const job = this.store.claim();
      if (!job) { await Bun.sleep(400); continue; }
      const started = Date.now();
      try {
        await this.run(job);
        this.store.complete(job.id);
        this.logger.info("job completed", { jobId: job.id, updateId: job.update_id, durationMs: Date.now()-started });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retry = !(error instanceof PermanentError) && job.attempts < 2;
        this.store.fail(job.id, message, retry);
        this.logger.error("job failed", { jobId: job.id, retry, error: message });
        if (!retry) await this.showError(job, message);
      }
    }
  }

  private async authorized(userId: number) {
    const cached = this.membershipCache.get(userId);
    if (cached && cached.expires > Date.now()) return cached.allowed;
    let allowed = false;
    try { allowed = isMember(await this.api.getChatMember(this.config.TELEGRAM_CHANNEL_ID, userId)); } catch { allowed = false; }
    this.membershipCache.set(userId, { allowed, expires: Date.now()+60_000 });
    return allowed;
  }

  private async run(job: JobRow) {
    const update = JSON.parse(job.payload) as Update;
    const parsed = parseUpdate(update, this.botId, this.username, this.config.TELEGRAM_DISCUSSION_GROUP_ID, this.store);
    if (parsed.kind !== "request") throw new PermanentError(parsed.kind === "invalid" ? parsed.reason : "消息已不可处理");
    const req = parsed.request;
    if (!await this.authorized(req.userId)) throw new PermanentError("只有频道成员可以使用此 Bot。");
    if (job.attempts === 1 && !this.limiter.allow(req.userId)) throw new PermanentError("请求过于频繁，请稍后再试。");

    let placeholder = job.placeholder_message_id;
    if (!placeholder) {
      const sent = await this.api.sendMessage(req.chatId, req.imageRefs.length ? "正在分析图片并搜索…" : "正在搜索…", { reply_parameters: { message_id: req.inputMessageId } });
      placeholder = sent.message_id; this.store.setPlaceholder(job.id, placeholder);
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
      const history = this.store.recentMedia(req.parentNodeId, this.config.MAX_IMAGES_PER_QUERY-prepared.length);
      for (const item of history) {
        if (prepared.some(x => x.hash === item.hash) || totalImageBytes+item.bytes > this.config.MAX_TOTAL_IMAGE_BYTES) continue;
        prepared.push(await loadPrepared(item.path,item.hash,item.mime_type,item.bytes)); totalImageBytes += item.bytes;
      }
    }

    const prompt = this.buildPrompt(req.parentNodeId, req.quotedText, req.question);
    const answer = await this.omp.ask(prompt, prepared);
    const chunks = splitText(answer);
    const outputIds: number[] = [];
    await this.editSafe(req.chatId, placeholder, chunks[0]!); outputIds.push(placeholder);
    for (const chunk of chunks.slice(1)) {
      const sent = await this.sendSafe(req.chatId, chunk, req.inputMessageId); outputIds.push(sent.message_id);
    }
    this.store.addConversation({ chatId:req.chatId,inputMessageId:req.inputMessageId,userId:req.userId,parentId:req.parentNodeId,question:req.question,quotedText:req.quotedText,answer,sources:extractSources(answer),outputIds,media:prepared.map(x=>({hash:x.hash,path:x.path,mimeType:x.mimeType,bytes:x.bytes})) });
  }

  private buildPrompt(parentId: number | undefined, quoted: string | undefined, question: string) {
    const sections: string[] = [];
    if (parentId) {
      const path = this.store.conversationPath(parentId);
      let transcript = path.map((n,i) => `第 ${i+1} 轮用户：${n.question}\n第 ${i+1} 轮助手：${n.answer}`).join("\n\n");
      if (transcript.length > this.config.CONTEXT_MAX_CHARS) transcript = transcript.slice(-this.config.CONTEXT_MAX_CHARS);
      sections.push(`<untrusted_conversation>\n${transcript}\n</untrusted_conversation>`);
    }
    if (quoted) sections.push(`<untrusted_quoted_message>\n${quoted.slice(0,4000)}\n</untrusted_quoted_message>`);
    sections.push(`<current_question>\n${question}\n</current_question>`);
    return sections.join("\n\n");
  }

  private async editSafe(chatId: number, messageId: number, text: string) {
    try { await this.api.editMessageText(chatId,messageId,toTelegramHtml(text),{parse_mode:"HTML",link_preview_options:{is_disabled:true}}); }
    catch { await this.api.editMessageText(chatId,messageId,text,{link_preview_options:{is_disabled:true}}); }
  }
  private async sendSafe(chatId: number, text: string, replyTo: number) {
    try { return await this.api.sendMessage(chatId,toTelegramHtml(text),{parse_mode:"HTML",link_preview_options:{is_disabled:true},reply_parameters:{message_id:replyTo}}); }
    catch { return await this.api.sendMessage(chatId,text,{link_preview_options:{is_disabled:true},reply_parameters:{message_id:replyTo}}); }
  }
  private async showError(job: JobRow, message: string) {
    const safe = message.includes("图片") || message.includes("频道") || message.includes("频繁") || message.includes("上下文") ? message : "搜索暂时失败，请稍后重试。";
    try {
      if (job.placeholder_message_id) await this.api.editMessageText(job.chat_id,job.placeholder_message_id,safe);
      else {
        const update = JSON.parse(job.payload) as Update;
        if (update.message) await this.api.sendMessage(job.chat_id,safe,{reply_parameters:{message_id:update.message.message_id}});
      }
    } catch {}
  }

  async cleanup() {
    for (const path of this.store.cleanup()) await unlink(path).catch(()=>{});
  }
}
