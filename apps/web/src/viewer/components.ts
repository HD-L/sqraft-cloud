/**
 * 主组件信息：名称（列表接口，每个版本取一次）与属性定义（主组件节点上的 propertyDefs，按需取单个组件的数据）。
 * 画布上的组件徽标与标注面板的「组件信息」共用。
 */
import type { ComponentPropertyDef, DocNode } from "@sqraft/core";
import { api } from "../api";
import { getPageDoc } from "./pageDocs";

export interface ComponentMeta {
  id: string;
  name: string;
  propertyDefs: ComponentPropertyDef[];
}

const lists = new Map<string, Promise<Map<string, ComponentMeta>>>();

/** 这个版本所有主组件：id → 名称与属性定义（列表接口已带 propertyDefs） */
export function componentsOf(designId: string, version: number): Promise<Map<string, ComponentMeta>> {
  const key = `${designId}@${version}`;
  let p = lists.get(key);
  if (!p) {
    p = api<{ components: Array<{ id: string; name: string; propertyDefs?: ComponentPropertyDef[] }> }>("GET", `/designs/${designId}/versions/${version}/components`)
      .then((r) => new Map(r.components.map((c) => [c.id, { id: c.id, name: c.name, propertyDefs: c.propertyDefs ?? [] }])))
      .catch(() => {
        // 失败不缓存：下次再用到时重新请求（网络抖动后不至于整页都只显示实例名）
        if (lists.get(key) === p) lists.delete(key);
        return new Map<string, ComponentMeta>();
      });
    lists.set(key, p);
    while (lists.size > 4) lists.delete(lists.keys().next().value as string);
  }
  return p;
}

export interface InstanceProp {
  name: string;
  value: string;
}

/**
 * 实例的属性值：用主组件的属性定义把 propValues（定义 id → 值）翻成「名称 = 值」。
 * 布尔值显示为 显示 / 隐藏；实例替换类属性显示被替换成的组件名。
 */
export function instanceProps(node: DocNode, meta: ComponentMeta | undefined, all: Map<string, ComponentMeta>): InstanceProp[] {
  if (!meta || !node.propValues) return [];
  const out: InstanceProp[] = [];
  for (const def of meta.propertyDefs) {
    const v = node.propValues[def.id];
    if (v === undefined) continue;
    let value: string;
    if (def.type === "boolean") value = v ? "显示" : "隐藏";
    else if (def.type === "instance") value = all.get(String(v))?.name ?? String(v);
    else value = String(v);
    out.push({ name: def.name, value });
  }
  return out;
}

/** 实例上被覆盖的图层数（overrides 的键数） */
export function overrideCount(node: DocNode): number {
  return node.overrides ? Object.keys(node.overrides).length : 0;
}

/** 预取主组件的页面数据（极少用到：列表接口没带属性定义的旧版本时兜底） */
export function componentDoc(designId: string, version: number, componentId: string) {
  return getPageDoc(designId, version, componentId);
}
