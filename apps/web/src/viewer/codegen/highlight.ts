/**
 * CSS 语法高亮：一个正则从左到右切词，输出带 <span class="c-*"> 的 HTML，不加依赖。
 * 类名：c-comment 注释、c-prop 属性名、c-value 关键字 / 字符串、c-num 数字与颜色、c-func 函数名、c-punct 标点。
 * 图层名等用户内容会出现在注释里，所以**所有**文本（包括未匹配的空白与杂项字符）都先转义再输出。
 */

const TOKEN = new RegExp(
  [
    String.raw`(\/\*[\s\S]*?(?:\*\/|$(?![\s\S])))`, // 1 注释（未闭合时到文末）
    String.raw`("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)`, // 2 字符串
    String.raw`^([ \t]*)(-{0,2}[a-zA-Z_][\w-]*)(?=[ \t]*:)`, // 3 缩进 + 4 行首属性名
    String.raw`(-{0,2}[a-zA-Z_][\w-]*)(?=\()`, // 5 函数名
    String.raw`(#[0-9a-fA-F]{3,8}\b|-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?)`, // 6 数字（含单位）与 hex 颜色
    String.raw`(-{0,2}[a-zA-Z_][\w-]*)`, // 7 关键字 / 变量名
    String.raw`([:;,(){}/*!])`, // 8 标点
  ].join("|"),
  "gm",
);

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

const span = (cls: string, s: string) => `<span class="c-${cls}">${escapeHtml(s)}</span>`;

export function highlightCss(code: string): string {
  let html = "";
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    html += escapeHtml(code.slice(last, m.index));
    if (m[1] !== undefined) html += span("comment", m[1]);
    else if (m[2] !== undefined) html += span("value", m[2]);
    else if (m[4] !== undefined) html += escapeHtml(m[3]) + span("prop", m[4]);
    else if (m[5] !== undefined) html += span("func", m[5]);
    else if (m[6] !== undefined) html += span("num", m[6]);
    else if (m[7] !== undefined) html += span("value", m[7]);
    else html += span("punct", m[0]);
    last = m.index + m[0].length;
  }
  return html + escapeHtml(code.slice(last));
}
