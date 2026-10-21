import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { Buffer } from "node:buffer";

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export interface ImageRef {
  fileId: string;
  mimeType: string;
  fileSize?: number;
}

export interface ImageData {
  base64: string;
  mimeType: string;
  bytes: number;
}

/** 从消息中提取一张图片：照片取最大尺寸，图片类文件，静态贴纸。 */
export function extractImage(msg: Message): ImageRef | null {
  const photo = msg.photo?.at(-1);
  if (photo) return { fileId: photo.file_id, mimeType: "image/jpeg", fileSize: photo.file_size };
  const doc = msg.document;
  if (doc?.mime_type?.startsWith("image/")) return { fileId: doc.file_id, mimeType: doc.mime_type, fileSize: doc.file_size };
  const sticker = msg.sticker;
  if (sticker && !sticker.is_animated && !sticker.is_video) {
    return { fileId: sticker.file_id, mimeType: "image/webp", fileSize: sticker.file_size };
  }
  return null;
}

export async function downloadImage(api: Api, token: string, ref: ImageRef): Promise<ImageData> {
  if (ref.fileSize && ref.fileSize > MAX_DOWNLOAD_BYTES) throw new Error("图片超过 20MB 限制");
  const file = await api.getFile(ref.fileId);
  if (!file.file_path) throw new Error("无法获取图片文件路径");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType: ref.mimeType, bytes: buf.byteLength };
}
