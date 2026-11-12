/**
 * MCP 只读工具（M3）。AI 按「项目 → 设计稿 → 页面 → 节点」逐层下钻，单次响应控制在几十 KB：
 * 没有「读整份文档」的工具。节点树摘要、布局检查、Token 直接复用 Sqraft 桌面端的实现
 * （`@sqraft/ai-tools`），在只含一个页面的文档上执行，输出格式与桌面端 MCP 一致。
 */

import { DocStore, type DocState } from "@sqraft/core";
import { makeExecutor } from "@sqraft/ai-tools";
import type { AppContext } from "../app";
import { projectRole, type Principal } from "../auth";
import { badRequest, notFound } from "../errors";
import type { DesignReader } from "../reader";
import type { VersionIndex } from "../indexer";
import { loadDesign, publicVersion, type DesignRow, type VersionRow } from "../routes/projects";

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });
const MAX_LIMIT_SCHEMA = 1000;
const VERSION = { type: ["integer", "string"], description: "版本号；省略时读当前版本（响应里会写明实际读的版本）" };
const DESIGN = str("设计稿 id（来自 list_designs）");

export const TOOLS: ToolInfo[] = [
  {
    name: "list_projects",
    description: "列出你有权限的项目（id、名称、你的角色、设计稿数）。不知道从哪个项目找设计稿时先调它。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_designs",
    description: "列出设计稿（id、名称、当前版本、页面数、更新时间）。可按项目筛选、按名称搜索。拿到设计稿 id 后用 list_pages 看页面。",
    inputSchema: {
      type: "object",
      properties: { projectId: str("只看这个项目；省略则列出所有有权限的项目里的设计稿"), query: str("按名称模糊搜索") },
      additionalProperties: false,
    },
  },
  {
    name: "list_versions",
    description: "列出设计稿的版本历史（版本号、说明、上传人、时间，标出当前版本）。需要对照旧版或确认依据哪一版开发时调用。",
    inputSchema: { type: "object", properties: { designId: DESIGN }, required: ["designId"], additionalProperties: false },
  },
  {
    name: "list_pages",
    description: "列出设计稿的页面（id、名称、尺寸、节点数）。实现某个界面前先用它找到页面 id，再用 read_page 读布局。",
    inputSchema: { type: "object", properties: { designId: DESIGN, version: VERSION }, required: ["designId"], additionalProperties: false },
  },
  {
    name: "read_page",
    description:
      "读取一个页面的节点树摘要：类型、名称、几何（相对父节点）、样式、文字、自动布局、实例引用的组件。按先序返回，" +
      "节点多时分页（返回 nextCursor 时用它继续读）。只关心某个区域时传 nodeId 只读那棵子树，传 depth 限制层数。" +
      "为控制体积，默认省略路径锚点（vector）与实例覆盖记录（overrides），子节点只给数量（childCount）。" +
      "需要精确的世界坐标与解析后的间距时用 inspect_layout。",
    inputSchema: {
      type: "object",
      properties: {
        designId: DESIGN,
        pageId: str("页面 id（来自 list_pages）"),
        version: VERSION,
        nodeId: str("只读这个节点及其子树"),
        depth: { type: "integer", minimum: 0, description: "相对起点的最大层数，0 = 只要起点本身" },
        cursor: str("上一页返回的 nextCursor"),
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT_SCHEMA, description: "每页节点数，默认 120" },
        includeVectors: { type: "boolean", description: "返回路径的完整锚点（默认只给锚点数；图标建议用 get_asset 取切图）" },
        includeOverrides: { type: "boolean", description: "返回实例的覆盖记录（默认省略：子节点已是覆盖后的结果）" },
      },
      required: ["designId", "pageId"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_layout",
    description:
      "读取页面或指定节点（含子树）的布局数据：世界坐标、是否绝对定位、自动布局方向 / gap / padding / wrap、hug / fill 行为，" +
      "以及 Token 解析后的实际间距。把设计稿还原成 CSS / 布局代码时调用。",
    inputSchema: {
      type: "object",
      properties: {
        designId: DESIGN,
        pageId: str("页面 id"),
        nodeIds: { type: "array", items: { type: "string" }, description: "只看这些节点（含子树）；省略则整页" },
        version: VERSION,
        cursor: str("上一页返回的 nextCursor"),
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT_SCHEMA, description: "每页节点数，默认 120" },
      },
      required: ["designId", "pageId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_tokens",
    description: "读取设计稿的设计 Token（颜色、数值）及取值。节点样式里的 fillToken / strokeToken 等引用这里的路径；写代码时优先映射成变量。",
    inputSchema: { type: "object", properties: { designId: DESIGN, version: VERSION }, required: ["designId"], additionalProperties: false },
  },
  {
    name: "list_components",
    description:
      "列出设计稿的主组件（id、名称、尺寸、属性定义、被实例引用次数），按引用次数从多到少。页面里的实例带 componentId，" +
      "可据此复用成代码组件。组件多时分页，可按名称搜索。",
    inputSchema: {
      type: "object",
      properties: {
        designId: DESIGN,
        version: VERSION,
        query: str("按组件名模糊搜索"),
        cursor: str("上一页返回的 nextCursor"),
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT_SCHEMA, description: "每页组件数，默认 200" },
      },
      required: ["designId"],
      additionalProperties: false,
    },
  },
  {
    name: "read_component",
    description: "读取一个主组件内部的节点树摘要（格式同 read_page）。实现可复用组件时调用。",
    inputSchema: {
      type: "object",
      properties: {
        designId: DESIGN,
        componentId: str("组件 id（来自 list_components 或实例的 componentId）"),
        version: VERSION,
        cursor: str("上一页返回的 nextCursor"),
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT_SCHEMA, description: "每页节点数，默认 120" },
        includeVectors: { type: "boolean", description: "返回路径的完整锚点" },
        includeOverrides: { type: "boolean", description: "返回实例的覆盖记录" },
      },
      required: ["designId", "componentId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_asset",
    description:
      "获取切图（位图）的下载链接：节点 image.assetId 即切图 id。返回 10 分钟有效的签名链接、格式、尺寸与字节数，" +
      "用 curl / 下载工具把文件存进项目资源目录。不返回图片内容本身。",
    inputSchema: {
      type: "object",
      properties: { designId: DESIGN, assetId: str("切图 id（节点 image.assetId）"), version: VERSION },
      required: ["designId", "assetId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_nodes",
    description: "按名称或文字内容搜索节点（不区分大小写），返回所在页面 / 组件与节点 id，最多 50 条。知道界面上的文案或图层名、不知道在哪一页时调用。",
    inputSchema: {
      type: "object",
      properties: {
        designId: DESIGN,
        query: str("要找的文字或图层名"),
        type: str("只要这种节点类型，如 text / frame / instance / image"),
        version: VERSION,
      },
      required: ["designId", "query"],
      additionalProperties: false,
    },
  },
];

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 1000;

interface Summary {
  id: string;
  parentId: string | null;
  [k: string]: unknown;
}

function stringArg(args: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw badRequest(`缺少参数 ${key}`);
    return undefined;
  }
  if (typeof v !== "string") throw badRequest(`参数 ${key} 需要字符串`);
  return v;
}

function executor(doc: DocState) {
  return makeExecutor(new DocStore(doc), async () => {
    throw new Error("私有云暂不支持截图");
  });
}

/**
 * 精简节点摘要：大稿里路径锚点与实例覆盖记录占了响应体积的四分之三，而写代码几乎用不到
 * （图标取切图；实例子节点已经是覆盖后的结果）。默认换成概要，需要时显式要。
 */
function compact(n: Summary, args: Record<string, unknown>): Summary {
  const { children, vector, overrides, ...rest } = n as Summary & { children?: unknown[]; vector?: { closed?: boolean; anchors?: unknown[] }; overrides?: Record<string, unknown> };
  const out: Summary = { ...rest };
  if (Array.isArray(children) && children.length) out.childCount = children.length;
  if (vector) out.vector = args.includeVectors === true ? vector : { closed: vector.closed ?? false, anchorCount: vector.anchors?.length ?? 0 };
  if (overrides && Object.keys(overrides).length) {
    if (args.includeOverrides === true) out.overrides = overrides;
    else out.overriddenCount = Object.keys(overrides).length;
  }
  return out;
}

/** 先序节点列表 → 按起点 / 层数过滤 → 分页。 */
function paginate(all: Summary[], args: Record<string, unknown>, rootId: string) {
  const start = stringArg(args, "nodeId", false) ?? rootId;
  const maxDepth = args.depth === undefined ? Infinity : Number(args.depth);
  if (!Number.isInteger(maxDepth) && maxDepth !== Infinity) throw badRequest("depth 需要非负整数");
  const limit = args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw badRequest(`limit 需要 1–${MAX_LIMIT} 的整数`);
  const offset = args.cursor === undefined ? 0 : Number(args.cursor);
  if (!Number.isInteger(offset) || offset < 0) throw badRequest("cursor 无效");

  const byId = new Map(all.map((n) => [n.id, n]));
  if (!byId.has(start)) throw notFound(`节点 ${start} 不在这个页面里`);
  const depthOf = new Map<string, number>([[start, 0]]);
  const picked: Summary[] = [];
  for (const n of all) {
    let d = depthOf.get(n.id);
    if (d === undefined && n.parentId !== null && depthOf.has(n.parentId)) {
      d = depthOf.get(n.parentId)! + 1;
      depthOf.set(n.id, d);
    }
    if (d !== undefined && d <= maxDepth) picked.push(d === maxDepth && Array.isArray(n.children) && n.children.length ? { ...n, truncated: true } : n);
  }
  const slice = picked.slice(offset, offset + limit).map((n) => compact(n, args));
  return {
    total: picked.length,
    nodes: slice,
    ...(offset + limit < picked.length ? { nextCursor: String(offset + limit) } : {}),
  };
}

export class McpTools {
  constructor(
    private readonly ctx: AppContext,
    private readonly reader: DesignReader,
  ) {}

  private design(p: Principal, args: Record<string, unknown>): DesignRow {
    return loadDesign(this.ctx.db, p, stringArg(args, "designId")!, "viewer");
  }

  private async open(p: Principal, args: Record<string, unknown>): Promise<{ design: DesignRow; version: VersionRow; idx: VersionIndex }> {
    const design = this.design(p, args);
    const version = this.reader.resolveVersion(design, args.version);
    return { design, version, idx: await this.reader.index(version) };
  }

  /** 返回 [结果 JSON, 审计用的设计稿 id] */
  async call(name: string, args: Record<string, unknown>, p: Principal, baseUrl: string): Promise<[unknown, string | null]> {
    const { db } = this.ctx;
    switch (name) {
      case "list_projects": {
        const rows = (
          p.user.is_admin === 1
            ? db.prepare("SELECT * FROM projects ORDER BY name").all()
            : db.prepare("SELECT pr.* FROM projects pr JOIN members m ON m.project_id = pr.id WHERE m.user_id = ? ORDER BY pr.name").all(p.user.id)
        ) as Array<{ id: string; name: string; archived_at: number | null }>;
        const projects = rows
          .map((r) => ({ r, role: projectRole(db, p, r.id) }))
          .filter((x) => x.role)
          .map(({ r, role }) => ({
            id: r.id,
            name: r.name,
            role,
            archived: r.archived_at !== null,
            designCount: (db.prepare("SELECT COUNT(*) AS n FROM designs WHERE project_id = ? AND deleted_at IS NULL").get(r.id) as { n: number }).n,
          }));
        return [{ projects }, null];
      }
      case "list_designs": {
        const projectId = stringArg(args, "projectId", false);
        const query = stringArg(args, "query", false)?.toLowerCase();
        const rows = db
          .prepare(
            `SELECT d.*, pr.name AS project_name FROM designs d JOIN projects pr ON pr.id = d.project_id
             WHERE d.deleted_at IS NULL ${projectId ? "AND d.project_id = ?" : ""} ORDER BY d.updated_at DESC`,
          )
          .all(...(projectId ? [projectId] : [])) as Array<DesignRow & { project_name: string }>;
        if (projectId && !projectRole(db, p, projectId)) throw notFound("项目不存在或没有权限");
        const designs = rows
          .filter((d) => projectRole(db, p, d.project_id) && (!query || d.name.toLowerCase().includes(query)))
          .slice(0, 200)
          .map((d) => {
            const v = d.current_version
              ? (db.prepare("SELECT page_count FROM versions WHERE design_id = ? AND number = ?").get(d.id, d.current_version) as { page_count: number })
              : null;
            return {
              id: d.id,
              name: d.name,
              projectId: d.project_id,
              projectName: d.project_name,
              currentVersion: d.current_version,
              pageCount: v?.page_count ?? 0,
              updatedAt: new Date(d.updated_at).toISOString(),
            };
          });
        return [{ designs }, null];
      }
      case "list_versions": {
        const design = this.design(p, args);
        const rows = db.prepare("SELECT * FROM versions WHERE design_id = ? ORDER BY number DESC").all(design.id) as VersionRow[];
        return [{ designId: design.id, versions: rows.map((v) => publicVersion(db, v, design.current_version)) }, design.id];
      }
      case "list_pages": {
        const { design, version, idx } = await this.open(p, args);
        return [
          {
            designId: design.id,
            version: version.number,
            pages: idx.pages.map((pg) => ({ id: pg.id, name: pg.name, width: pg.width, height: pg.height, nodeCount: pg.nodeCount })),
          },
          design.id,
        ];
      }
      case "read_page": {
        const { design, version, idx } = await this.open(p, args);
        const pageId = stringArg(args, "pageId")!;
        const page = idx.pages.find((pg) => pg.id === pageId);
        if (!page) throw notFound(`页面 ${pageId} 不存在`);
        const out = JSON.parse(await executor(await this.reader.subtreeDoc(version, idx, pageId))("read_document", {})) as {
          pages: Array<{ subtree: string }>;
        };
        const all = JSON.parse(out.pages[0].subtree) as Summary[];
        return [
          {
            designId: design.id,
            version: version.number,
            page: { id: page.id, name: page.name, width: page.width, height: page.height },
            ...paginate(all, args, pageId),
          },
          design.id,
        ];
      }
      case "read_component": {
        const { design, version, idx } = await this.open(p, args);
        const componentId = stringArg(args, "componentId")!;
        const comp = idx.components.find((c) => c.id === componentId);
        if (!comp) throw notFound(`组件 ${componentId} 不存在`);
        const out = JSON.parse(
          await executor(await this.reader.subtreeDoc(version, idx, componentId))("read_document", { includeComponentTrees: true }),
        ) as { components: Array<{ subtree: string }> };
        const all = JSON.parse(out.components[0].subtree) as Summary[];
        return [
          {
            designId: design.id,
            version: version.number,
            component: { id: comp.id, name: comp.name, width: comp.width, height: comp.height, propertyDefs: comp.propertyDefs ?? [] },
            ...paginate(all, { ...args, nodeId: undefined }, componentId),
          },
          design.id,
        ];
      }
      case "inspect_layout": {
        const { design, version, idx } = await this.open(p, args);
        const pageId = stringArg(args, "pageId")!;
        if (!idx.pages.some((pg) => pg.id === pageId)) throw notFound(`页面 ${pageId} 不存在`);
        const nodeIds = args.nodeIds;
        if (nodeIds !== undefined && (!Array.isArray(nodeIds) || nodeIds.some((x) => typeof x !== "string"))) {
          throw badRequest("nodeIds 需要字符串数组");
        }
        const raw = await executor(await this.reader.subtreeDoc(version, idx, pageId))("inspect_layout", {
          pageId,
          ...(nodeIds ? { nodeIds } : {}),
        });
        const { nodes, ...restLayout } = JSON.parse(raw) as { nodes: unknown[] };
        const limit = args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw badRequest(`limit 需要 1–${MAX_LIMIT} 的整数`);
        const offset = args.cursor === undefined ? 0 : Number(args.cursor);
        if (!Number.isInteger(offset) || offset < 0) throw badRequest("cursor 无效");
        return [
          {
            designId: design.id,
            version: version.number,
            ...restLayout,
            total: nodes.length,
            nodes: nodes.slice(offset, offset + limit),
            ...(offset + limit < nodes.length ? { nextCursor: String(offset + limit) } : {}),
          },
          design.id,
        ];
      }
      case "get_tokens": {
        const { design, version, idx } = await this.open(p, args);
        return [{ designId: design.id, version: version.number, tokens: idx.tokens }, design.id];
      }
      case "list_components": {
        const { design, version, idx } = await this.open(p, args);
        const query = stringArg(args, "query", false)?.toLowerCase();
        const limit = args.limit === undefined ? 200 : Number(args.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw badRequest(`limit 需要 1–${MAX_LIMIT} 的整数`);
        const offset = args.cursor === undefined ? 0 : Number(args.cursor);
        if (!Number.isInteger(offset) || offset < 0) throw badRequest("cursor 无效");
        const all = idx.components
          .filter((c) => !query || c.name.toLowerCase().includes(query))
          .sort((a, b) => b.instanceCount - a.instanceCount);
        return [
          {
            designId: design.id,
            version: version.number,
            total: all.length,
            components: all.slice(offset, offset + limit).map(({ blob: _b, ...c }) => c),
            ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}),
          },
          design.id,
        ];
      }
      case "get_asset": {
        const { design, version, idx } = await this.open(p, args);
        const assetId = stringArg(args, "assetId")!;
        const asset = idx.assets[assetId];
        if (!asset) throw notFound(`切图 ${assetId} 不存在`);
        const signed = this.reader.signAssetPath(design.id, version.number, assetId);
        return [
          {
            designId: design.id,
            version: version.number,
            assetId,
            fileName: asset.name,
            mime: asset.mime,
            width: asset.width,
            height: asset.height,
            bytes: asset.size,
            url: `${baseUrl}${signed.path}`,
            expiresAt: new Date(signed.expiresAt).toISOString(),
          },
          design.id,
        ];
      }
      case "search_nodes": {
        const { design, version, idx } = await this.open(p, args);
        const query = stringArg(args, "query")!.toLowerCase();
        const type = stringArg(args, "type", false);
        const rootName = new Map<string, string>([
          ...idx.pages.map((pg) => [pg.id, pg.name] as [string, string]),
          ...idx.components.map((c) => [c.id, c.name] as [string, string]),
        ]);
        const pageIds = new Set(idx.pages.map((pg) => pg.id));
        const results = [];
        for (const [id, nodeType, name, text, rootId] of await this.reader.search(idx)) {
          if (type && nodeType !== type) continue;
          if (!name.toLowerCase().includes(query) && !text.toLowerCase().includes(query)) continue;
          results.push({
            id,
            type: nodeType,
            name,
            ...(text ? { text } : {}),
            [pageIds.has(rootId) ? "pageId" : "componentId"]: rootId,
            in: rootName.get(rootId) ?? "",
          });
          if (results.length >= 50) break;
        }
        return [{ designId: design.id, version: version.number, results, truncated: results.length >= 50 }, design.id];
      }
      default:
        throw notFound(`没有这个工具：${name}`);
    }
  }
}
