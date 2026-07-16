import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Api } from "grammy";
import type { Config } from "./config.ts";
import type { ImageRef, PreparedImage } from "./types.ts";

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("图片超过大小限制");
  if (!response.body) throw new Error("图片下载响应没有内容");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("图片超过大小限制");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export async function prepareImage(api: Api, ref: ImageRef, config: Config, remainingBytes = config.MAX_TOTAL_IMAGE_BYTES): Promise<PreparedImage> {
  const byteLimit = Math.min(config.MAX_IMAGE_BYTES, remainingBytes);
  if (byteLimit <= 0 || (ref.fileSize && ref.fileSize > byteLimit)) throw new Error("图片超过本次请求的大小限制");
  const file = await api.getFile(ref.fileId);
  if (!file.file_path) throw new Error("Telegram 未返回图片下载地址");
  if (file.file_size && file.file_size > byteLimit) throw new Error("图片超过大小限制");
  const response = await fetch(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  if (!response.ok) throw new Error(`下载图片失败 (${response.status})`);
  const input = await readLimited(response, byteLimit);
  const metadata = await sharp(input).metadata();
  if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format)) throw new Error("仅支持 JPEG、PNG 和 WebP 静态图片");
  const usePng = metadata.hasAlpha === true;
  let pipeline = sharp(input, { animated: false }).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).withMetadata({});
  const output = usePng ? await pipeline.png({ compressionLevel: 8 }).toBuffer() : await pipeline.jpeg({ quality: 88 }).toBuffer();
  const mimeType = usePng ? "image/png" as const : "image/jpeg" as const;
  const hash = createHash("sha256").update(output).digest("hex");
  const dir = join(config.DATA_DIR, "media"); await mkdir(dir, { recursive: true });
  const path = join(dir, `${hash}.${usePng ? "png" : "jpg"}`);
  await writeFile(path, output);
  return { hash, path, mimeType, bytes: output.byteLength, sourceBytes: input.byteLength, base64: output.toString("base64") };
}

export async function loadPrepared(path: string, hash: string, mimeType: string, bytes: number): Promise<PreparedImage> {
  const data = await readFile(path);
  return { path, hash, mimeType: mimeType as PreparedImage["mimeType"], bytes, sourceBytes: bytes, base64: data.toString("base64") };
}
