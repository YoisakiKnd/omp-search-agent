import type { Update } from "grammy/types";

export interface JobRow {
  id: number;
  update_id: number;
  user_id: number;
  chat_id: number;
  payload: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  placeholder_message_id: number | null;
}

export interface ConversationNode {
  id: number;
  parent_node_id: number | null;
  user_id: number;
  question: string;
  quoted_text: string | null;
  answer: string;
  sources_json: string;
  created_at: number;
  expires_at: number;
}

export interface StoredUpdate { update: Update }

export interface ParsedRequest {
  userId: number;
  chatId: number;
  inputMessageId: number;
  question: string;
  quotedText?: string;
  parentNodeId?: number;
  imageRefs: ImageRef[];
  isFollowUp: boolean;
}

export interface ImageRef {
  fileId: string;
  uniqueId: string;
  mimeType?: string;
  fileSize?: number;
  origin: "current" | "quoted";
}

export interface PreparedImage {
  hash: string;
  path: string;
  mimeType: "image/jpeg" | "image/png";
  bytes: number;
  sourceBytes: number;
  base64: string;
}
