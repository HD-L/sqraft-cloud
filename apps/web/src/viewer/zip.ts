/**
 * 最小的 zip 写入器：切图打包下载用，只存储不压缩（PNG / JPG / WEBP 本身已压缩，再 deflate 几乎不省空间）。
 *
 * - 文件名一律按 UTF-8 写入，并置通用标志位 11，中文名在 macOS / Windows 10+ / unzip 下都不乱码；
 * - 名字里的 "/" 就是目录（如 "drawable-xhdpi/icon.png"），解压时自动建目录，不单独写目录项；
 * - 不支持 ZIP64：单个文件或整个包超过 4 GiB、条目超过 65535 个时直接报错（切图远到不了）。
 *
 * 纯函数、不碰 DOM，便于单测。
 */

export interface ZipEntry {
  /** 包内路径，用 "/" 分隔目录 */
  name: string;
  data: Uint8Array;
  /** 修改时间，缺省为打包时刻 */
  date?: Date;
}

let table: Uint32Array | null = null;

/** CRC-32（IEEE 802.3，多项式 0xEDB88320），zip 用的就是这一种 */
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** zip 里的时间是 MS-DOS 格式的本地时间：2 秒精度，最早 1980 年 */
function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date, time };
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const END_SIZE = 22;
/** 解压所需版本 2.0（STORE 本身 1.0 就够，2.0 兼容性最好） */
const VERSION = 20;
/** 通用标志位 11：文件名与注释是 UTF-8 */
const FLAG_UTF8 = 0x0800;
const MAX_U32 = 0xffffffff;

/** 把若干文件打成一个不压缩的 zip（STORE），返回整个归档的字节 */
export function zipStore(files: ReadonlyArray<ZipEntry>): Uint8Array<ArrayBuffer> {
  if (files.length > 0xffff) throw new Error("文件太多，无法打包（上限 65535 个）");
  const encoder = new TextEncoder();
  const now = new Date();
  const items = files.map((f) => {
    const name = encoder.encode(f.name);
    if (name.length > 0xffff) throw new Error(`文件名太长：${f.name}`);
    if (f.data.length > MAX_U32) throw new Error(`文件太大，无法打包：${f.name}`);
    return { name, data: f.data, crc: crc32(f.data), ...dosDateTime(f.date ?? now) };
  });

  let localTotal = 0;
  let centralTotal = 0;
  for (const it of items) {
    localTotal += LOCAL_SIZE + it.name.length + it.data.length;
    centralTotal += CENTRAL_SIZE + it.name.length;
  }
  if (localTotal + centralTotal > MAX_U32) throw new Error("打包内容超过 4 GiB，无法生成 zip");

  const out = new Uint8Array(localTotal + centralTotal + END_SIZE);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let p = 0;

  // 本地文件头 + 数据
  for (const it of items) {
    offsets.push(p);
    view.setUint32(p, LOCAL_SIG, true);
    view.setUint16(p + 4, VERSION, true);
    view.setUint16(p + 6, FLAG_UTF8, true);
    view.setUint16(p + 8, 0, true); // 压缩方式 0 = STORE
    view.setUint16(p + 10, it.time, true);
    view.setUint16(p + 12, it.date, true);
    view.setUint32(p + 14, it.crc, true);
    view.setUint32(p + 18, it.data.length, true); // 压缩后大小
    view.setUint32(p + 22, it.data.length, true); // 原始大小
    view.setUint16(p + 26, it.name.length, true);
    view.setUint16(p + 28, 0, true); // 扩展字段长度
    out.set(it.name, p + LOCAL_SIZE);
    out.set(it.data, p + LOCAL_SIZE + it.name.length);
    p += LOCAL_SIZE + it.name.length + it.data.length;
  }

  // 中央目录
  const centralStart = p;
  items.forEach((it, i) => {
    view.setUint32(p, CENTRAL_SIG, true);
    view.setUint16(p + 4, VERSION, true); // 制作者版本（高字节 0 = MS-DOS，属性取默认）
    view.setUint16(p + 6, VERSION, true);
    view.setUint16(p + 8, FLAG_UTF8, true);
    view.setUint16(p + 10, 0, true);
    view.setUint16(p + 12, it.time, true);
    view.setUint16(p + 14, it.date, true);
    view.setUint32(p + 16, it.crc, true);
    view.setUint32(p + 20, it.data.length, true);
    view.setUint32(p + 24, it.data.length, true);
    view.setUint16(p + 28, it.name.length, true);
    // 30 扩展字段长度、32 注释长度、34 起始磁盘号、36 内部属性、38 外部属性：全为 0
    view.setUint32(p + 42, offsets[i], true);
    out.set(it.name, p + CENTRAL_SIZE);
    p += CENTRAL_SIZE + it.name.length;
  });

  // 中央目录结束记录（无注释）
  view.setUint32(p, END_SIG, true);
  // 4 本磁盘号、6 中央目录起始磁盘号：0
  view.setUint16(p + 8, items.length, true);
  view.setUint16(p + 10, items.length, true);
  view.setUint32(p + 12, p - centralStart, true);
  view.setUint32(p + 16, centralStart, true);
  // 20 注释长度：0
  return out;
}
