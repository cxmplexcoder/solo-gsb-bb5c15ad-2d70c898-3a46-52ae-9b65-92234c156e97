import { describe, expect, it } from 'vitest';
import {
  analyzeCrossImpact,
  computeSideChanges,
  type ImpactEntry,
} from './crossAnalysis';
import { ABSENT, type JsonValue } from './types';

const byKind = (entries: ImpactEntry[], kind: ImpactEntry['kind']) =>
  entries.filter((e) => e.kind === kind);

describe('computeSideChanges', () => {
  it('对象内改动展开到叶子路径；新增 / 删除子树整体记一条', () => {
    const base = { a: 1, obj: { x: 1, y: 2 }, gone: { deep: true } };
    const side = { a: 2, obj: { x: 1, y: 3 }, added: { deep: [1] } };
    const changes = computeSideChanges(base as JsonValue, side as JsonValue);
    expect(changes.map((c) => `${c.kind}:${c.pointer}`)).toEqual([
      'replace:/a',
      'replace:/obj/y',
      'remove:/gone',
      'add:/added',
    ]);
    // 新增子树整体一条，不展开到 /added/deep
    expect(changes.find((c) => c.pointer === '/added')?.value).toEqual({ deep: [1] });
    // 删除子树整体一条，基线值保留
    expect(changes.find((c) => c.pointer === '/gone')?.base).toEqual({ deep: true });
  });

  it('数组按整体值处理，不做元素级展开', () => {
    const changes = computeSideChanges({ list: [1, 2, 3] }, { list: [1, 9] });
    expect(changes).toHaveLength(1);
    expect(changes[0].pointer).toBe('/list');
    expect(changes[0].kind).toBe('replace');
    expect(changes[0].value).toEqual([1, 9]);
  });

  it('对象与标量互转、根路径整体变化均记为整体替换', () => {
    expect(computeSideChanges({ a: { x: 1 } }, { a: 5 })).toEqual([
      expect.objectContaining({ pointer: '/a', kind: 'replace', value: 5 }),
    ]);
    const root = computeSideChanges({ a: 1 }, [1, 2]);
    expect(root).toHaveLength(1);
    expect(root[0].pointer).toBe('');
    expect(root[0].kind).toBe('replace');
  });

  it('完全一致时无变更', () => {
    expect(computeSideChanges({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
  });
});

describe('analyzeCrossImpact 同一路径', () => {
  it('两侧改成不同的值 → 同路径冲突', () => {
    const r = analyzeCrossImpact({ a: 1 }, { a: 2 }, { a: 3 });
    expect(r.counts.conflict).toBe(1);
    expect(r.counts.total).toBe(1);
    const e = byKind(r.entries, 'conflict')[0];
    expect(e.pointer).toBe('/a');
    expect(e.reason).toBe('双方修改为不同的值');
    expect(e.oursChange?.value).toBe(2);
    expect(e.theirsChange?.value).toBe(3);
  });

  it('一侧删除、另一侧修改 → 同路径冲突并标明方向', () => {
    const r = analyzeCrossImpact({ a: 1, b: 1 }, { b: 1 }, { a: 9, b: 1 });
    const e = byKind(r.entries, 'conflict')[0];
    expect(e.pointer).toBe('/a');
    expect(e.reason).toBe('当前分支已删除，目标分支进行了修改');
    expect(e.oursChange?.kind).toBe('remove');
    expect(e.theirsChange?.kind).toBe('replace');
  });

  it('两侧新增同一路径不同值 → 冲突；相同值 → 双方同改', () => {
    const conflict = analyzeCrossImpact({}, { a: 1 }, { a: 2 });
    expect(byKind(conflict.entries, 'conflict')[0].pointer).toBe('/a');

    const same = analyzeCrossImpact({}, { a: [1] }, { a: [1] });
    const e = byKind(same.entries, 'same-change')[0];
    expect(e.pointer).toBe('/a');
    expect(e.reason).toContain('相同');
  });

  it('双方都删除同一路径 → 双方同改', () => {
    const r = analyzeCrossImpact({ a: 1, b: 2 }, { b: 2 }, { b: 2 });
    expect(r.counts['same-change']).toBe(1);
    expect(r.counts.conflict).toBe(0);
    const e = byKind(r.entries, 'same-change')[0];
    expect(e.pointer).toBe('/a');
    expect(e.oursChange?.value).toBe(ABSENT);
    expect(e.theirsChange?.value).toBe(ABSENT);
  });
});

describe('analyzeCrossImpact 祖先 × 后代交叉', () => {
  it('一侧整体替换祖先、另一侧修改后代 → 祖先覆盖交叉（当前分支侧）', () => {
    const base = { svc: { host: 'a', port: 80 } };
    const ours = { svc: ['replaced'] };
    const theirs = { svc: { host: 'a', port: 8080 } };
    const r = analyzeCrossImpact(base as JsonValue, ours as JsonValue, theirs as JsonValue);

    expect(r.counts['ancestor-override']).toBe(1);
    expect(r.counts.conflict).toBe(0);
    const e = byKind(r.entries, 'ancestor-override')[0];
    expect(e.pointer).toBe('/svc');
    expect(e.relatedPointer).toBe('/svc/port');
    expect(e.overrideSide).toBe('ours');
    expect(e.oursChange?.kind).toBe('replace');
    expect(e.theirsChange?.pointer).toBe('/svc/port');
    expect(e.reason).toContain('当前分支整体替换了祖先路径');
  });

  it('一侧删除祖先、另一侧修改后代 → 祖先覆盖交叉（目标分支侧），可波及多个后代', () => {
    const base = { svc: { a: 1, b: 2 }, keep: 1 };
    const ours = { svc: { a: 10, b: 20 }, keep: 1 };
    const theirs = { keep: 1 };
    const r = analyzeCrossImpact(base as JsonValue, ours as JsonValue, theirs as JsonValue);

    const crosses = byKind(r.entries, 'ancestor-override');
    expect(crosses).toHaveLength(2);
    expect(crosses.every((e) => e.pointer === '/svc' && e.overrideSide === 'theirs')).toBe(true);
    expect(crosses.map((e) => e.relatedPointer).sort()).toEqual(['/svc/a', '/svc/b']);
    expect(crosses[0].reason).toContain('目标分支整体删除了祖先路径');
  });

  it('根路径整体替换 × 另一侧任意修改 → 根上的祖先覆盖交叉', () => {
    const r = analyzeCrossImpact({ a: 1 }, [1, 2], { a: 2 });
    const e = byKind(r.entries, 'ancestor-override')[0];
    expect(e.pointer).toBe('');
    expect(e.relatedPointer).toBe('/a');
    expect(e.overrideSide).toBe('ours');
  });

  it('祖先与后代同侧修改不算交叉；两侧改同一数组 → 同路径冲突而非祖先交叉', () => {
    // 同一侧既改祖先（对象内）又改后代：对象内修改展开为叶子，互不相干
    const sameSide = analyzeCrossImpact(
      { a: { x: 1 }, b: 1 },
      { a: { x: 2 }, b: 2 },
      { a: { x: 1 }, b: 1 },
    );
    expect(sameSide.counts['ancestor-override']).toBe(0);

    // 数组按整体值处理：两侧改同一数组是同一路径冲突
    const arr = analyzeCrossImpact({ l: [1, 2] }, { l: [1, 2, 3] }, { l: [0, 2] });
    expect(arr.counts.conflict).toBe(1);
    expect(arr.counts['ancestor-override']).toBe(0);
    expect(byKind(arr.entries, 'conflict')[0].pointer).toBe('/l');
  });
});

describe('analyzeCrossImpact 可自动合并与汇总', () => {
  it('对象内互不相干的改动 → 全部标为可自动合并', () => {
    const base = { a: 1, b: 2, nested: { x: 1, y: 1 } };
    const ours = { a: 10, b: 2, nested: { x: 2, y: 1 } };
    const theirs = { a: 1, b: 20, nested: { x: 1, y: 2 } };
    const r = analyzeCrossImpact(base, ours, theirs);

    expect(r.counts.total).toBe(4);
    expect(r.counts['auto-merge']).toBe(4);
    expect(r.oursChangeCount).toBe(2);
    expect(r.theirsChangeCount).toBe(2);
    const auto = byKind(r.entries, 'auto-merge');
    expect(auto.map((e) => e.pointer).sort()).toEqual(['/a', '/b', '/nested/x', '/nested/y']);
    expect(auto.find((e) => e.pointer === '/a')?.oursChange).toBeDefined();
    expect(auto.find((e) => e.pointer === '/b')?.theirsChange).toBeDefined();
  });

  it('混合场景：冲突 / 祖先交叉 / 双方同改 / 可自动合并同时出现且排序正确', () => {
    const base = { c: 1, same: 1, free: 1, tree: { x: 1, y: 2 } };
    const ours = { c: 2, same: 9, free: 1, tree: ['gone'] };
    const theirs = { c: 3, same: 9, free: 2, tree: { x: 1, y: 3 } };
    const r = analyzeCrossImpact(base as JsonValue, ours as JsonValue, theirs as JsonValue);

    expect(r.counts.conflict).toBe(1); // /c
    expect(r.counts['same-change']).toBe(1); // /same
    expect(r.counts['ancestor-override']).toBe(1); // /tree × /tree/y
    expect(r.counts['auto-merge']).toBe(1); // /free
    // 排序：冲突 → 祖先交叉 → 双方同改 → 可自动合并
    expect(r.entries.map((e) => e.kind)).toEqual([
      'conflict',
      'ancestor-override',
      'same-change',
      'auto-merge',
    ]);
  });

  it('三方一致时无任何条目', () => {
    const r = analyzeCrossImpact({ a: 1 }, { a: 1 }, { a: 1 });
    expect(r.entries).toEqual([]);
    expect(r.counts.total).toBe(0);
    expect(r.oursChangeCount).toBe(0);
    expect(r.theirsChangeCount).toBe(0);
  });

  it('特殊键名按 RFC 6901 转义（~ → ~0，/ → ~1）', () => {
    const r = analyzeCrossImpact({ 'a/b': 1, 'c~d': 1 }, { 'a/b': 2, 'c~d': 1 }, { 'a/b': 3, 'c~d': 1 });
    const e = byKind(r.entries, 'conflict')[0];
    expect(e.pointer).toBe('/a~1b');
    expect(e.segments).toEqual(['a/b']);
  });
});
