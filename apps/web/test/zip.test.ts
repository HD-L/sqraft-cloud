import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocState } from "@sqraft/core";
import { BLUR_EXTENT } from "@sqraft/core";
import { crc32, zipStore } from "../src/viewer/zip";
import { exportBounds, exportSize, exportTargets, MAX_EXPORT_SIDE, safeFileName, targetPath } from "../src/viewer/exportImage";

const enc = new TextEncoder();
const dec = new TextDecoder();

interface ReadEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  size: number;
  data: Uint8Array;
  time: number;
  date: number;
}

/** 测试用的极简读取器：从结束记录找中央目录，逐项对照本地文件头取出数据 */
function readZip(buf: Uint8Array): ReadEntry[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const end = buf.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  expect(v.getUint16(end + 8, true)).toBe(count);
  const cdSize = v.getUint32(end + 12, true);
  const cdOffset = v.getUint32(end + 16, true);
  expect(cdOffset + cdSize).toBe(end);
  const out: ReadEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const time = v.getUint16(p + 12, true);
    const date = v.getUint16(p + 14, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    expect(csize).toBe(size);
    // 本地文件头要与中央目录一致
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    expect(v.getUint16(local + 6, true)).toBe(flags);
    expect(v.getUint16(local + 8, true)).toBe(method);
    expect(v.getUint32(local + 14, true)).toBe(crc);
    expect(v.getUint32(local + 18, true)).toBe(size);
    expect(v.getUint32(local + 22, true)).toBe(size);
    const lNameLen = v.getUint16(local + 26, true);
    const lExtra = v.getUint16(local + 28, true);
    expect(dec.decode(buf.subarray(local + 30, local + 30 + lNameLen))).toBe(name);
    const start = local + 30 + lNameLen + lExtra;
    out.push({ name, flags, method, crc, size, data: buf.slice(start, start + size), time, date });
    p += 46 + nameLen + extraLen + commentLen;
  }
  expect(p).toBe(end);
  return out;
}

function hasUnzip(): boolean {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

const FILES = [
  { name: "icon.png", data: bytes(100) },
  { name: "icon@2x.png", data: bytes(4000, 7) },
  { name: "图标-返回@3x.png", data: enc.encode("中文内容") },
  { name: "drawable-xhdpi/ic_back.png", data: bytes(1, 9) },
  { name: "empty.txt", data: new Uint8Array(0) },
];

describe("crc32", () => {
  it("标准校验值", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(enc.encode("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
});

describe("zipStore", () => {
  it("中央目录、文件名（含中文）、大小、CRC 与数据都能原样读回", () => {
    const zip = zipStore(FILES);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(FILES.map((f) => f.name));
    entries.forEach((e, i) => {
      expect(e.flags & 0x0800).toBe(0x0800);
      expect(e.method).toBe(0);
      expect(e.size).toBe(FILES[i].data.length);
      expect(e.crc).toBe(crc32(FILES[i].data));
      expect(Array.from(e.data)).toEqual(Array.from(FILES[i].data));
    });
    // 总长 = 本地头 + 数据 + 中央目录 + 结束记录
    const names = FILES.reduce((s, f) => s + enc.encode(f.name).length, 0);
    const data = FILES.reduce((s, f) => s + f.data.length, 0);
    expect(zip.length).toBe(FILES.length * (30 + 46) + names * 2 + data + 22);
  });

  it("DOS 日期时间", () => {
    const [e] = readZip(zipStore([{ name: "a", data: bytes(3), date: new Date(2024, 4, 17, 13, 45, 59) }]));
    expect(e.date).toBe(((2024 - 1980) << 9) | (5 << 5) | 17);
    expect(e.time).toBe((13 << 11) | (45 << 5) | 29);
    // 1980 年以前的时间夹到 1980
    const [old] = readZip(zipStore([{ name: "b", data: bytes(3), date: new Date(1970, 0, 1) }]));
    expect(old.date >> 9).toBe(0);
  });

  it("空归档只有结束记录", () => {
    const zip = zipStore([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it.skipIf(!hasUnzip())("unzip 能列出并校验通过", () => {
    const dir = mkdtempSync(join(tmpdir(), "sqraft-zip-"));
    try {
      const file = join(dir, "test.zip");
      writeFileSync(file, zipStore(FILES));
      const list = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
      for (const name of ["icon.png", "icon@2x.png", "drawable-xhdpi/ic_back.png", "empty.txt"]) expect(list).toContain(name);
      expect(list).toMatch(/\b5 files\b/);
      // -t 会逐个校验 CRC
      const test = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
      expect(test).toContain("No errors detected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- 切图导出里不碰 DOM 的部分：档位、文件名、导出范围与尺寸 ----

const n = (id: string, type: string, parentId: string | null, children: string[], extra: Record<string, unknown> = {}) => ({
  id, type, name: id, parentId, children, x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, style: {}, ...extra,
});
function doc(nodes: ReturnType<typeof n>[]): DocState {
  return { version: 1, rootIds: [nodes[0].id], nodes: Object.fromEntries(nodes.map((x) => [x.id, x])), tokens: {} } as unknown as DocState;
}

describe("exportTargets", () => {
  it("iOS：@1x/@2x/@3x，倍率 = 目标密度 / 设计稿倍率", () => {
    const t = exportTargets("ios", 2);
    expect(t.map((x) => x.label)).toEqual(["@1x", "@2x", "@3x"]);
    expect(t.map((x) => x.scale)).toEqual([0.5, 1, 1.5]);
    expect(t.map((x) => targetPath(x, "back", "png"))).toEqual(["back.png", "back@2x.png", "back@3x.png"]);
  });

  it("Android：drawable-* 目录、文件同名", () => {
    const t = exportTargets("android", 2);
    expect(t.map((x) => x.folder)).toEqual(["drawable-mdpi", "drawable-hdpi", "drawable-xhdpi", "drawable-xxhdpi", "drawable-xxxhdpi"]);
    expect(t.map((x) => x.scale)).toEqual([0.5, 0.75, 1, 1.5, 2]);
    expect(targetPath(t[2], "ic_back", "webp")).toBe("drawable-xhdpi/ic_back.webp");
  });

  it("Web / 小程序：1x 与 2x；非法的设计稿倍率按 1", () => {
    for (const p of ["web", "mp"] as const) {
      const t = exportTargets(p, 0);
      expect(t.map((x) => x.label)).toEqual(["1x", "2x"]);
      expect(t.map((x) => x.scale)).toEqual([1, 2]);
      expect(t.map((x) => targetPath(x, "a", "jpg"))).toEqual(["a.jpg", "a@2x.jpg"]);
    }
  });
});

describe("safeFileName", () => {
  it("空格与斜杠换成 -，去掉非法字符和首尾的点", () => {
    expect(safeFileName("图标/返回 按钮", "ios")).toBe("图标-返回-按钮");
    expect(safeFileName("a / b", "web")).toBe("a-b");
    expect(safeFileName('a:b*c?"d<e>f|g\\h', "web")).toBe("abcdefg-h");
    expect(safeFileName("  .hidden. ", "web")).toBe("hidden");
    expect(safeFileName("", "web")).toBe("image");
    expect(safeFileName("con", "web")).toBe("con_");
    expect(Array.from(safeFileName("长".repeat(200), "web")).length).toBe(60);
  });

  it("Android：小写、只留 [a-z0-9_]、不以数字开头、避开 Java 关键字", () => {
    expect(safeFileName("Icon/Back Arrow", "android")).toBe("icon_back_arrow");
    expect(safeFileName("ic-close@2x", "android")).toBe("ic_close_2x");
    expect(safeFileName("3D 图标", "android")).toBe("img_3d");
    expect(safeFileName("返回", "android")).toBe("image");
    expect(safeFileName("Café", "android")).toBe("cafe");
    expect(safeFileName("Class", "android")).toBe("class_img");
    expect(safeFileName("返回", "android")).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe("exportBounds / exportSize", () => {
  const shadow = { type: "drop-shadow", visible: true, x: 0, y: 2, blur: 4, spread: 0, color: { value: "#000" } };
  const d = doc([
    n("pg", "page", null, ["card", "clipbox", "g", "line"], { x: 1000, y: 500, width: 375, height: 812 }),
    n("card", "rect", "pg", [], { x: 10, y: 20, width: 24, height: 24, style: { effects: [shadow] } }),
    n("clipbox", "frame", "pg", ["overflow", "ghost"], { x: 100, y: 100, width: 50, height: 50, clip: true }),
    n("overflow", "rect", "clipbox", [], { x: 30, y: 30, width: 200, height: 200 }),
    n("ghost", "rect", "clipbox", [], { x: -500, y: 0, width: 10, height: 10, visible: false }),
    n("g", "group", "pg", ["a", "b", "hid"], { x: 200, y: 200, width: 999, height: 999 }),
    n("a", "rect", "g", [], { x: 0, y: 0, width: 10, height: 10, style: { stroke: { value: "#000" }, strokeWidth: 2 } }),
    n("b", "ellipse", "g", [], { x: 20, y: 30, width: 10, height: 10 }),
    n("hid", "rect", "g", [], { x: 500, y: 500, width: 10, height: 10, visible: false }),
    n("line", "line", "pg", [], { x: 0, y: 300, width: 100, height: 0 }),
  ]);

  it("画板就是画板矩形", () => {
    expect(exportBounds(d, "pg")).toEqual({ x: 1000, y: 500, width: 375, height: 812 });
  });

  it("含投影外扩（按偏移往一侧）；@3x 尺寸 = (宽高 + 外扩) × 3 / 设计稿倍率", () => {
    const g = shadow.blur * BLUR_EXTENT;
    const b = exportBounds(d, "card")!;
    // 投影 (0, 2, 4)：左右各外扩 g，上边 g − 2，下边 g + 2
    expect(b).toEqual({ x: 1010 - g, y: 520 - g + 2, width: 24 + 2 * g, height: 24 + 2 * g });
    const at3x = exportTargets("ios", 2)[2];
    expect(exportSize(b, at3x.scale)).toEqual({ width: Math.ceil(((24 + 2 * g) * 3) / 2), height: Math.ceil(((24 + 2 * g) * 3) / 2), scale: 1.5 });
  });

  it("裁切容器不算溢出的子图层，隐藏图层不算", () => {
    expect(exportBounds(d, "clipbox")).toEqual({ x: 1100, y: 600, width: 50, height: 50 });
  });

  it("编组由可见子图层决定，描边外扩半个线宽；直线按 1px 描边", () => {
    expect(exportBounds(d, "g")).toEqual({ x: 1199, y: 699, width: 31, height: 41 });
    // 外扩四周一致（端点多留半像素，线帽是方 / 圆头时也不被裁）
    expect(exportBounds(d, "line")).toEqual({ x: 999.5, y: 799.5, width: 101, height: 1 });
    expect(exportBounds(d, "missing")).toBeNull();
  });

  it("向上取整时扣掉浮点误差，最长边封顶", () => {
    expect(exportSize({ width: 24, height: 24 }, 1.5)).toEqual({ width: 36, height: 36, scale: 1.5 });
    expect(exportSize({ width: 0.1 * 3, height: 10 }, 10).width).toBe(3);
    expect(exportSize({ width: 25, height: 1 }, 1 / 3)).toEqual({ width: 9, height: 1, scale: 1 / 3 });
    const big = exportSize({ width: 10000, height: 5000 }, 2);
    expect(big).toEqual({ width: MAX_EXPORT_SIDE, height: MAX_EXPORT_SIDE / 2, scale: MAX_EXPORT_SIDE / 10000 });
  });
});
