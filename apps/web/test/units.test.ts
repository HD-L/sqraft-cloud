import { describe, expect, it } from "vitest";
import { defaultPrefs, migratePrefs, normalizePrefs, prefs, resolvePrefs, setDesignScale, toggleCollapsed, type InspectPrefs } from "../src/viewer/prefs";
import { autoDesignScale, fmtLen, fmtNum, lenUnit, lenValue, PLATFORM_LABEL, summary, unitCtx } from "../src/viewer/units";

const P = (over: Partial<InspectPrefs> = {}): InspectPrefs => ({ ...defaultPrefs(), ...over });

describe("自动设计稿倍率", () => {
  it("按画板宽判断：≤480 → 1，640–828 → 2，1080–1284 → 3，其他 → 1", () => {
    expect(autoDesignScale(320)).toBe(1);
    expect(autoDesignScale(375)).toBe(1);
    expect(autoDesignScale(480)).toBe(1);
    expect(autoDesignScale(560)).toBe(1);
    expect(autoDesignScale(640)).toBe(2);
    expect(autoDesignScale(750)).toBe(2);
    expect(autoDesignScale(828)).toBe(2);
    expect(autoDesignScale(900)).toBe(1);
    expect(autoDesignScale(1080)).toBe(3);
    expect(autoDesignScale(1125)).toBe(3);
    expect(autoDesignScale(1284)).toBe(3);
    expect(autoDesignScale(1440)).toBe(1);
    expect(autoDesignScale(0)).toBe(1);
    expect(autoDesignScale(Number.NaN)).toBe(1);
  });

  it("unitCtx：没记录 / auto 时自动；记了数字就用数字", () => {
    expect(unitCtx(P(), "d1", 750)).toMatchObject({ scale: 2, autoScale: true, pageWidth: 750 });
    expect(unitCtx(P({ designScale: { d1: "auto" } }), "d1", 1125)).toMatchObject({ scale: 3, autoScale: true });
    expect(unitCtx(P({ designScale: { d1: 1 } }), "d1", 750)).toMatchObject({ scale: 1, autoScale: false });
    // 倍率按设计稿分别记
    expect(unitCtx(P({ designScale: { d1: 1 } }), "d2", 750)).toMatchObject({ scale: 2, autoScale: true });
    // 不合法的数字按自动处理
    expect(unitCtx(P({ designScale: { d1: 0 } }), "d1", 750)).toMatchObject({ scale: 2, autoScale: true });
  });
});

describe("长度换算", () => {
  it("750 宽 @auto → @2x，iOS 下 20 → 10pt，整板宽 375pt", () => {
    const ctx = unitCtx(P({ platform: "ios" }), "d", 750);
    expect(ctx.scale).toBe(2);
    expect(fmtLen(20, ctx)).toBe("10");
    expect(lenUnit(ctx)).toBe("pt");
    expect(fmtLen(20, ctx, { withUnit: true })).toBe("10pt");
    expect(fmtLen(750, ctx, { withUnit: true })).toBe("375pt");
  });

  it("小程序 rpx 按画板宽换算，与设计稿倍率无关", () => {
    expect(fmtLen(20, unitCtx(P({ platform: "mp" }), "d", 375), { withUnit: true })).toBe("40rpx");
    expect(fmtLen(20, unitCtx(P({ platform: "mp" }), "d", 750), { withUnit: true })).toBe("20rpx");
    // 手动改倍率不影响 rpx
    expect(fmtLen(20, unitCtx(P({ platform: "mp", designScale: { d: 3 } }), "d", 375))).toBe("40");
    // 文字也用 rpx
    expect(lenUnit(unitCtx(P({ platform: "mp" }), "d", 375), { text: true })).toBe("rpx");
  });

  it("Web rem：logical / 基准", () => {
    const ctx = unitCtx(P({ webUnit: "rem", remBase: 16 }), "d", 375);
    expect(fmtLen(20, ctx)).toBe("1.25");
    expect(lenUnit(ctx)).toBe("rem");
    expect(lenUnit(ctx, { text: true })).toBe("rem");
    // 2x 稿先除倍率再除基准
    expect(fmtLen(40, unitCtx(P({ webUnit: "rem", remBase: 16 }), "d", 750), { withUnit: true })).toBe("1.25rem");
    expect(fmtLen(20, unitCtx(P({ webUnit: "rem", remBase: 10 }), "d", 375))).toBe("2");
    // 精度作用在逻辑像素上，rem 本身最多 4 位小数，不会把 13px 写成 0.81rem
    expect(fmtLen(13, unitCtx(P({ webUnit: "rem", remBase: 16 }), "d", 375))).toBe("0.8125");
    expect(fmtLen(1, unitCtx(P({ webUnit: "rem", remBase: 16, precision: 0 }), "d", 375))).toBe("0.0625");
    expect(fmtLen(14.4, unitCtx(P({ webUnit: "rem", remBase: 16, precision: 0 }), "d", 375))).toBe("0.875");
    expect(fmtLen(14.4, unitCtx(P({ webUnit: "rem", remBase: 16, precision: 1 }), "d", 375))).toBe("0.9");
  });

  it("Web px 取逻辑值", () => {
    const ctx = unitCtx(P(), "d", 750);
    expect(lenValue(33, ctx)).toBe(16.5);
    expect(fmtLen(33, ctx, { withUnit: true })).toBe("16.5px");
  });

  it("Android：尺寸 dp，文字 sp，数值相同", () => {
    const ctx = unitCtx(P({ platform: "android" }), "d", 1080);
    expect(lenUnit(ctx)).toBe("dp");
    expect(lenUnit(ctx, { text: true })).toBe("sp");
    expect(fmtLen(48, ctx, { withUnit: true })).toBe("16dp");
    expect(fmtLen(42, ctx, { text: true, withUnit: true })).toBe("14sp");
  });

  it("精度：2 位、1 位、取整", () => {
    const at = (precision: 0 | 1 | 2) => unitCtx(P({ platform: "ios", precision, designScale: { d: 3 } }), "d", 1125);
    expect(fmtLen(10, at(2))).toBe("3.33");
    expect(fmtLen(10, at(1))).toBe("3.3");
    expect(fmtLen(10, at(0))).toBe("3");
    expect(fmtLen(11, at(0))).toBe("4");
  });
});

describe("fmtNum", () => {
  it("四舍五入、去掉末尾 0", () => {
    expect(fmtNum(12, 2)).toBe("12");
    expect(fmtNum(12.5, 2)).toBe("12.5");
    expect(fmtNum(12.345, 2)).toBe("12.35");
    expect(fmtNum(1.005, 2)).toBe("1.01");
    expect(fmtNum(0.1 + 0.2, 2)).toBe("0.3");
    expect(fmtNum(2.5, 0)).toBe("3");
    expect(fmtNum(1.96, 1)).toBe("2");
  });

  it("不会出现 -0；负数与正数对称", () => {
    expect(fmtNum(-0, 2)).toBe("0");
    expect(fmtNum(-0.001, 2)).toBe("0");
    expect(fmtNum(-0.4, 0)).toBe("0");
    expect(fmtNum(-2.5, 0)).toBe("-3");
    expect(fmtNum(-1.25, 1)).toBe("-1.3");
  });

  it("非有限值输出 0", () => {
    expect(fmtNum(Number.NaN, 2)).toBe("0");
    expect(fmtNum(Number.POSITIVE_INFINITY, 2)).toBe("0");
  });
});

describe("设置摘要", () => {
  it("各平台", () => {
    expect(summary(unitCtx(P({ platform: "ios" }), "d", 750))).toBe("iOS · pt · 设计稿 @2x（自动：画板宽 750）");
    expect(summary(unitCtx(P({ webUnit: "rem", designScale: { d: 1 } }), "d", 1440))).toBe("Web · rem(16) · 设计稿 @1x");
    expect(summary(unitCtx(P({ platform: "mp" }), "d", 750))).toBe("小程序 · rpx · 按画板宽 750 换算");
    expect(summary(unitCtx(P(), "d", 375))).toBe("Web · px · 设计稿 @1x（自动：画板宽 375）");
    expect(summary(unitCtx(P({ platform: "android", designScale: { d: 3 } }), "d", 1080))).toBe("Android · dp/sp · 设计稿 @3x");
  });

  it("平台名", () => {
    expect(PLATFORM_LABEL).toEqual({ web: "Web", ios: "iOS", android: "Android", mp: "小程序" });
  });
});

describe("设置读取与 v1 迁移", () => {
  it("v1 → v2：px → web、pt → ios、dp → android；颜色照搬；旧倍率丢弃", () => {
    expect(migratePrefs({ unit: "px", scale: 2, color: "rgba" })).toEqual({ ...defaultPrefs(), platform: "web", color: "rgba" });
    expect(migratePrefs({ unit: "pt", scale: 1, color: "hsla" })).toEqual({ ...defaultPrefs(), platform: "ios", color: "hsla" });
    expect(migratePrefs({ unit: "dp", scale: 3, color: "hex" })).toEqual({ ...defaultPrefs(), platform: "android", color: "hex" });
    expect(migratePrefs({ unit: "em", color: "cmyk" })).toEqual(defaultPrefs());
    expect(migratePrefs(null)).toEqual(defaultPrefs());
    expect(migratePrefs("px")).toEqual(defaultPrefs());
  });

  it("v2 优先；没有 v2 才迁移 v1；都没有或坏掉用默认值", () => {
    const v2 = JSON.stringify({ ...defaultPrefs(), platform: "mp" });
    const v1 = JSON.stringify({ unit: "pt", scale: 2, color: "rgba" });
    expect(resolvePrefs(v2, v1)).toEqual({ prefs: { ...defaultPrefs(), platform: "mp" }, migrated: false });
    expect(resolvePrefs(null, v1)).toEqual({ prefs: { ...defaultPrefs(), platform: "ios", color: "rgba" }, migrated: true });
    expect(resolvePrefs("{broken", v1).migrated).toBe(true);
    expect(resolvePrefs(null, null)).toEqual({ prefs: defaultPrefs(), migrated: false });
    expect(resolvePrefs("not json", "also not")).toEqual({ prefs: defaultPrefs(), migrated: false });
    expect(resolvePrefs("[1,2]", "42")).toEqual({ prefs: defaultPrefs(), migrated: false });
  });

  it("v2 校验：不合法字段取默认值", () => {
    const p = normalizePrefs({
      platform: "windows",
      webUnit: "em",
      remBase: -4,
      precision: 3,
      color: "hex8",
      designScale: { a: 2, b: "auto", c: 0, d: "3", e: Number.NaN, f: 1.5 },
      positionBase: "parent",
      tokenVars: "yes",
      collapsed: ["css", 1, "css", "text"],
      exportFormat: "gif",
    });
    expect(p).toEqual({
      ...defaultPrefs(),
      color: "hex8",
      designScale: { a: 2, f: 1.5 },
      positionBase: "parent",
      collapsed: ["css", "text"],
    });
    expect(normalizePrefs({ precision: 0, webUnit: "rem", remBase: 10, tokenVars: false })).toMatchObject({
      precision: 0,
      webUnit: "rem",
      remBase: 10,
      tokenVars: false,
    });
  });

  it("默认值每次都是新对象", () => {
    const a = defaultPrefs();
    a.collapsed.push("x");
    a.designScale.d = 2;
    expect(defaultPrefs()).toEqual({
      platform: "web",
      webUnit: "px",
      remBase: 16,
      precision: 2,
      color: "hex",
      designScale: {},
      positionBase: "artboard",
      tokenVars: true,
      collapsed: [],
      exportFormat: "png",
    });
  });
});

describe("设置存储（无 localStorage 时退回默认值）", () => {
  it("setDesignScale：数字记下，auto / 不合法删掉记录", () => {
    setDesignScale("d", 2);
    expect(prefs.designScale).toEqual({ d: 2 });
    expect(unitCtx(prefs, "d", 375)).toMatchObject({ scale: 2, autoScale: false });
    setDesignScale("d", "auto");
    expect(prefs.designScale).toEqual({});
    setDesignScale("d", -1);
    expect(prefs.designScale).toEqual({});
  });

  it("toggleCollapsed 来回切换", () => {
    toggleCollapsed("css");
    toggleCollapsed("text");
    expect(prefs.collapsed).toEqual(["css", "text"]);
    toggleCollapsed("css");
    expect(prefs.collapsed).toEqual(["text"]);
    toggleCollapsed("text");
    expect(prefs.collapsed).toEqual([]);
  });
});
