import { resolve } from "node:path";
import { z } from "zod";

const bool = z.string().optional().transform((v) => v == null ? true : !["0", "false", "no"].includes(v.toLowerCase()));

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  TELEGRAM_CHANNEL_ID: z.coerce.number().int(),
  TELEGRAM_DISCUSSION_GROUP_ID: z.coerce.number().int(),
  OMP_MODEL: z.string().min(1),
  OMP_SEARCH_PROVIDER: z.string().default("auto"),
  POLLING_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(50).default(30),
  POLLING_LIMIT: z.coerce.number().int().min(1).max(100).default(100),
  CONTEXT_TTL_HOURS: z.coerce.number().positive().default(24),
  CONTEXT_MAX_TURNS: z.coerce.number().int().min(1).max(20).default(6),
  CONTEXT_MAX_CHARS: z.coerce.number().int().min(1000).default(16000),
  MAX_IMAGES_PER_QUERY: z.coerce.number().int().min(1).max(10).default(4),
  MAX_IMAGE_BYTES: z.coerce.number().int().min(1024).max(20 * 1024 * 1024).default(10 * 1024 * 1024),
  MAX_TOTAL_IMAGE_BYTES: z.coerce.number().int().min(1024).max(20 * 1024 * 1024).default(20 * 1024 * 1024),
  GLOBAL_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  QUEUE_LIMIT: z.coerce.number().int().min(1).default(50),
  QUERY_TIMEOUT_MS: z.coerce.number().int().min(5000).default(90000),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1000).default(30000),
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  REQUIRE_VISION_MODEL: bool,
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`);
  }
  return { ...parsed.data, DATA_DIR: resolve(parsed.data.DATA_DIR) };
}
