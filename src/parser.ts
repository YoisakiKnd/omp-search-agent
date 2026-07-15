import type { Message, MessageEntity, Update } from "grammy/types";
import type { Store } from "./database.ts";
import type { ImageRef, ParsedRequest } from "./types.ts";

function body(message: Message): { text: string; entities: MessageEntity[] } {
  if ("text" in message && message.text) return { text: message.text, entities: message.entities ?? [] };
  if ("caption" in message && message.caption) return { text: message.caption, entities: message.caption_entities ?? [] };
  return { text: "", entities: [] };
}

function stripBotMention(text: string, entities: MessageEntity[], username: string) {
  let found = false;
  const ranges: Array<[number, number]> = [];
  for (const entity of entities) {
    if (entity.type !== "mention") continue;
    const value = text.slice(entity.offset, entity.offset + entity.length);
    if (value.toLowerCase() === `@${username.toLowerCase()}`) {
      found = true; ranges.push([entity.offset, entity.offset + entity.length]);
    }
  }
  let cleaned = text;
  for (const [start, end] of ranges.sort((a,b) => b[0]-a[0])) cleaned = cleaned.slice(0,start) + cleaned.slice(end);
  return { found, text: cleaned.replace(/^\s*[:,，：-]?\s*/, "").trim() };
}

function images(message: Message | undefined, origin: ImageRef["origin"]): ImageRef[] {
  if (!message) return [];
  if ("photo" in message && message.photo?.length) {
    const photo = [...message.photo].sort((a,b) => (b.file_size ?? b.width*b.height) - (a.file_size ?? a.width*a.height))[0]!;
    return [{ fileId: photo.file_id, uniqueId: photo.file_unique_id, fileSize: photo.file_size, mimeType: "image/jpeg", origin }];
  }
  if ("document" in message && message.document && ["image/jpeg","image/png","image/webp"].includes(message.document.mime_type ?? "")) {
    return [{ fileId: message.document.file_id, uniqueId: message.document.file_unique_id, fileSize: message.document.file_size, mimeType: message.document.mime_type, origin }];
  }
  return [];
}

function quotedText(message: Message | undefined): string | undefined {
  if (!message) return undefined;
  const value = body(message).text.trim();
  if (!value) return images(message, "quoted").length ? "[引用消息包含一张图片]" : undefined;
  const from = "from" in message && message.from ? [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") : "未知用户";
  return `${from}: ${value}`;
}

export type ParseResult = { kind: "ignore" } | { kind: "invalid"; reason: string; chatId: number; replyTo: number } | { kind: "request"; request: ParsedRequest };

export function parseUpdate(update: Update, botId: number, username: string, discussionGroupId: number, store: Store): ParseResult {
  const message = update.message;
  if (!message || message.chat.id !== discussionGroupId || !message.from || message.from.is_bot) return { kind: "ignore" };
  const { text, entities } = body(message);
  const mention = stripBotMention(text, entities, username);
  const replied = message.reply_to_message;
  const repliesToBot = replied?.from?.id === botId;
  const parent = repliesToBot && replied ? store.parentForMessage(message.chat.id, replied.message_id) : null;

  if (repliesToBot && !parent) {
    return { kind: "invalid", reason: "这条回答的上下文已过期，请重新 @我并提供完整问题。", chatId: message.chat.id, replyTo: message.message_id };
  }
  const crossUserReply = Boolean(parent && parent.user_id !== message.from.id);
  if (crossUserReply && !mention.found) {
    return { kind: "invalid", reason: "为避免群友之间串联上下文，请 @我并提供完整问题；其他用户的会话不会被继承。", chatId: message.chat.id, replyTo: message.message_id };
  }
  if (!repliesToBot && !mention.found) return { kind: "ignore" };
  if (!mention.text) {
    return { kind: "invalid", reason: "请在提及我或回复回答时附上具体问题。", chatId: message.chat.id, replyTo: message.message_id };
  }

  return { kind: "request", request: {
    userId: message.from.id,
    chatId: message.chat.id,
    inputMessageId: message.message_id,
    question: mention.text,
    quotedText: replied && !repliesToBot ? quotedText(replied) : undefined,
    parentNodeId: crossUserReply ? undefined : parent?.id,
    imageRefs: [...images(message, "current"), ...(replied && !repliesToBot ? images(replied, "quoted") : [])],
    isFollowUp: Boolean(parent && !crossUserReply),
  }};
}
