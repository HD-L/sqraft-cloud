/** 只读文件头识别图片格式与尺寸（PNG / JPEG / GIF / WebP / SVG），不解码像素。 */

export interface ImageInfo {
  mime: string;
  width: number | null;
  height: number | null;
}

export const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bin: "application/octet-stream",
};

function jpegSize(b: Buffer): [number, number] | null {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o += 1;
      continue;
    }
    const marker = b[o + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [b.readUInt16BE(o + 7), b.readUInt16BE(o + 5)];
    }
    o += 2 + b.readUInt16BE(o + 2);
  }
  return null;
}

function webpSize(b: Buffer): [number, number] | null {
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (chunk === "VP8X") return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  return null;
}

export function sniffImage(head: Buffer, ext: string): ImageInfo {
  const fallback = MIME_BY_EXT[ext] ?? "application/octet-stream";
  let size: [number, number] | null = null;
  let mime = fallback;
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) {
    mime = "image/png";
    size = [head.readUInt32BE(16), head.readUInt32BE(20)];
  } else if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    mime = "image/jpeg";
    size = jpegSize(head);
  } else if (head.length >= 10 && head.toString("ascii", 0, 3) === "GIF") {
    mime = "image/gif";
    size = [head.readUInt16LE(6), head.readUInt16LE(8)];
  } else if (head.length >= 30 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
    mime = "image/webp";
    size = webpSize(head);
  }
  return { mime, width: size?.[0] ?? null, height: size?.[1] ?? null };
}
