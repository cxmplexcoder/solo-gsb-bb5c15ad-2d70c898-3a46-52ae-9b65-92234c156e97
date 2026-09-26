import { deepEqual } from './deepEqual';
import { toPointer } from './pointer';
import { ABSENT, isAbsent, isPlainObject, type JsonValue, type SideValue } from './types';

/**
 * 输入阶段的「变更交叉分析」：分别计算当前分支（Ours）、目标分支（Theirs）相对
 * 基线（Base）的结构化变更，再按 JSON Pointer 交叉比对两侧变更，生成影响矩阵。
 *
 * 变更粒度与三方合并语义一致：只有对象按键递归展开；数组与标量按整体值处理。
 * 交叉识别三类核心影响：
 * 1. 同一路径冲突——两侧改了同一路径且值不同（含一侧删除、另一侧修改）；
 * 2. 祖先整体替换 / 删除 × 后代修改——一侧在祖先路径整体替换或删除，
 *    另一侧的变更落在其严格后代路径上；
 * 3. 互不相干的改动——路径既不相同也不构成祖先-后代交叉，可自动合并。
 * 同一路径两侧改成相同值（含都删除）归为「双方同改」，同样可自动合并。
 */

/** 单侧相对基线的一处结构化变更 */
export interface SideChange {
  /** RFC 6901 JSON Pointer，根为 '' */
  pointer: string;
  /** 从根到本节点的路径段（未转义） */
  segments: string[];
  kind: 'add' | 'remove' | 'replace';
  /** 基线侧值；新增时为 ABSENT */
  base: SideValue;
  /** 该侧新值；删除时为 ABSENT */
  value: SideValue;
}

/** 影响类型 */
export type ImpactKind =
  | 'conflict' // 同一路径两侧改成不同值（含一侧删除、另一侧修改）
  | 'ancestor-override' // 一侧祖先整体替换/删除，另一侧修改了其后代
  | 'same-change' // 同一路径两侧改成相同值（含都删除），采用一次
  | 'auto-merge'; // 互不相干的改动，可自动合并

/** 影响矩阵条目 */
export interface ImpactEntry {
  id: string;
  kind: ImpactKind;
  /** 主路径：冲突 / 双方同改 / 可自动合并为变更路径；祖先交叉为整体替换/删除的祖先路径 */
  pointer: string;
  segments: string[];
  /** 仅祖先交叉：另一侧被波及的后代变更路径 */
  relatedPointer?: string;
  relatedSegments?: string[];
  /** 两侧变更（可自动合并时仅一侧存在） */
  oursChange?: SideChange;
  theirsChange?: SideChange;
  /** 仅祖先交叉：整体替换/删除发生在哪一侧 */
  overrideSide?: 'ours' | 'theirs';
  /** 影响说明 */
  reason: string;
}

export interface CrossAnalysis {
  entries: ImpactEntry[];
  /** 各影响类型计数与总条目数 */
  counts: Record<ImpactKind, number> & { total: number };
  /** 两侧相对基线的结构化变更总数 */
  oursChangeCount: number;
  theirsChangeCount: number;
}

export const IMPACT_LABEL: Record<ImpactKind, string> = {
  conflict: '同路径冲突',
  'ancestor-override': '祖先覆盖交叉',
  'same-change': '双方同改',
  'auto-merge': '可自动合并',
};

export const IMPACT_FILTERS: { key: ImpactKind; label: string }[] = [
  { key: 'conflict', label: IMPACT_LABEL.conflict },
  { key: 'ancestor-override', label: IMPACT_LABEL['ancestor-override'] },
  { key: 'same-change', label: IMPACT_LABEL['same-change'] },
  { key: 'auto-merge', label: IMPACT_LABEL['auto-merge'] },
];

export const SIDE_CHANGE_LABEL: Record<SideChange['kind'], string> = {
  add: '新增',
  remove: '删除',
  replace: '修改',
};

/**
 * 计算一侧相对基线的结构化变更清单。
 * 对象按键递归展开到具体子路径；数组与标量按整体值处理（变化即整体一条 replace）；
 * 新增 / 删除的子树整体记一条，不展开。
 */
export function computeSideChanges(base: JsonValue, side: JsonValue): SideChange[] {
  const changes: SideChange[] = [];
  collectSideChanges(base, side, [], changes);
  return changes;
}

function collectSideChanges(
  base: SideValue,
  side: SideValue,
  segments: string[],
  out: SideChange[],
): void {
  if (deepEqual(base, side)) return;
  // 仅对象按键递归；数组与标量均按单个值整体处理
  if (isPlainObject(base) && isPlainObject(side)) {
    const keys: string[] = [];
    for (const k of Object.keys(base)) keys.push(k);
    for (const k of Object.keys(side)) if (!(k in base)) keys.push(k);
    for (const k of keys) {
      collectSideChanges(
        k in base ? base[k] : ABSENT,
        k in side ? side[k] : ABSENT,
        [...segments, k],
        out,
      );
    }
    return;
  }
  const kind: SideChange['kind'] = isAbsent(base) ? 'add' : isAbsent(side) ? 'remove' : 'replace';
  out.push({ pointer: toPointer(segments), segments, kind, base, value: side });
}

/** b 是否为 a 的严格祖先路径（b 短于 a 且为其前缀） */
function isStrictAncestor(ancestor: string[], descendant: string[]): boolean {
  if (ancestor.length >= descendant.length) return false;
  return ancestor.every((seg, i) => seg === descendant[i]);
}

function conflictReason(o: SideChange, t: SideChange): string {
  if (o.kind === 'remove' && t.kind !== 'remove') return '当前分支已删除，目标分支进行了修改';
  if (t.kind === 'remove' && o.kind !== 'remove') return '目标分支已删除，当前分支进行了修改';
  return '双方修改为不同的值';
}

function overrideReason(override: SideChange, side: 'ours' | 'theirs'): string {
  const sideLabel = side === 'ours' ? '当前分支' : '目标分支';
  const otherLabel = side === 'ours' ? '目标分支' : '当前分支';
  const action = override.kind === 'remove' ? '整体删除' : '整体替换';
  return `${sideLabel}${action}了祖先路径，${otherLabel}修改了其下的后代路径`;
}

/** 影响类型的展示 / 排序优先级 */
const KIND_ORDER: Record<ImpactKind, number> = {
  conflict: 0,
  'ancestor-override': 1,
  'same-change': 2,
  'auto-merge': 3,
};

/**
 * 交叉分析：基于 Base、Ours、Theirs 生成按 JSON Pointer 组织的影响矩阵。
 * 同一路径的两侧变更按值是否相同分为「同路径冲突」/「双方同改」；
 * 一侧在祖先路径整体替换或删除、另一侧变更落在其严格后代路径上记为「祖先覆盖交叉」
 * （对象内的就地修改已展开到叶子，故此处的祖先变更必为整体替换 / 删除）；
 * 其余互不相干的变更记为「可自动合并」。
 */
export function analyzeCrossImpact(
  base: JsonValue,
  ours: JsonValue,
  theirs: JsonValue,
): CrossAnalysis {
  const oursChanges = computeSideChanges(base, ours);
  const theirsChanges = computeSideChanges(base, theirs);
  const entries: ImpactEntry[] = [];
  // 已参与交叉（冲突 / 祖先覆盖 / 双方同改）的变更路径，剩余即为可自动合并
  const crossedOurs = new Set<string>();
  const crossedTheirs = new Set<string>();
  const theirsByPointer = new Map(theirsChanges.map((c) => [c.pointer, c]));

  // 1) 同一路径：值不同 → 冲突；值相同（含都删除）→ 双方同改
  for (const o of oursChanges) {
    const t = theirsByPointer.get(o.pointer);
    if (!t) continue;
    crossedOurs.add(o.pointer);
    crossedTheirs.add(t.pointer);
    const same = deepEqual(o.value, t.value);
    entries.push({
      id: `same:${o.pointer}`,
      kind: same ? 'same-change' : 'conflict',
      pointer: o.pointer,
      segments: o.segments,
      oursChange: o,
      theirsChange: t,
      reason: same ? '两侧改成相同的值，自动采用一次' : conflictReason(o, t),
    });
  }

  // 2) 祖先整体替换/删除 × 后代修改（两个方向）
  //    祖先侧必为 replace / remove：对象内就地修改已展开到叶子，不会产生祖先条目
  const isWholeOverride = (c: SideChange) => c.kind === 'replace' || c.kind === 'remove';
  const collectOverrides = (
    ancestors: SideChange[],
    descendants: SideChange[],
    side: 'ours' | 'theirs',
  ) => {
    for (const a of ancestors) {
      if (!isWholeOverride(a)) continue;
      for (const d of descendants) {
        if (!isStrictAncestor(a.segments, d.segments)) continue;
        crossedOurs.add(side === 'ours' ? a.pointer : d.pointer);
        crossedTheirs.add(side === 'ours' ? d.pointer : a.pointer);
        entries.push({
          id: `override:${side}:${a.pointer}:${d.pointer}`,
          kind: 'ancestor-override',
          pointer: a.pointer,
          segments: a.segments,
          relatedPointer: d.pointer,
          relatedSegments: d.segments,
          oursChange: side === 'ours' ? a : d,
          theirsChange: side === 'ours' ? d : a,
          overrideSide: side,
          reason: overrideReason(a, side),
        });
      }
    }
  };
  collectOverrides(oursChanges, theirsChanges, 'ours');
  collectOverrides(theirsChanges, oursChanges, 'theirs');

  // 3) 互不相干的改动：未参与任何交叉，可自动合并
  for (const o of oursChanges) {
    if (crossedOurs.has(o.pointer)) continue;
    entries.push({
      id: `auto:ours:${o.pointer}`,
      kind: 'auto-merge',
      pointer: o.pointer,
      segments: o.segments,
      oursChange: o,
      reason: '仅当前分支修改，与目标分支的变更互不相干',
    });
  }
  for (const t of theirsChanges) {
    if (crossedTheirs.has(t.pointer)) continue;
    entries.push({
      id: `auto:theirs:${t.pointer}`,
      kind: 'auto-merge',
      pointer: t.pointer,
      segments: t.segments,
      theirsChange: t,
      reason: '仅目标分支修改，与当前分支的变更互不相干',
    });
  }

  entries.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.pointer.localeCompare(b.pointer) ||
      (a.relatedPointer ?? '').localeCompare(b.relatedPointer ?? ''),
  );

  const counts = {
    conflict: 0,
    'ancestor-override': 0,
    'same-change': 0,
    'auto-merge': 0,
    total: entries.length,
  };
  for (const e of entries) counts[e.kind]++;

  return {
    entries,
    counts,
    oursChangeCount: oursChanges.length,
    theirsChangeCount: theirsChanges.length,
  };
}
