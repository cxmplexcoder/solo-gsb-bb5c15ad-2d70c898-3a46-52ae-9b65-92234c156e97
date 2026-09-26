// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import AnalysisStage from './AnalysisStage';
import type { JsonValue } from '../merge/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const all = (container: HTMLElement, sel: string) => [...container.querySelectorAll(sel)];
const btnByText = (container: HTMLElement, text: string) =>
  all(container, 'button').find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

const BASE: JsonValue = { c: 1, same: 1, free: 1, tree: { x: 1, y: 2 } };
const OURS: JsonValue = { c: 2, same: 9, free: 1, tree: ['gone'] };
const THEIRS: JsonValue = { c: 3, same: 9, free: 2, tree: { x: 1, y: 3 } };

function setup(base: JsonValue = BASE, ours: JsonValue = OURS, theirs: JsonValue = THEIRS) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const calls: string[] = [];
  const render = (node: ReactElement) => act(() => root.render(node));
  render(
    <AnalysisStage
      base={base}
      ours={ours}
      theirs={theirs}
      onProceedMerge={() => calls.push('merge')}
      onBack={() => calls.push('back')}
    />,
  );
  return { container, calls };
}

const rows = (container: HTMLElement) => all(container, '.cross-row') as HTMLElement[];
const detailOf = (container: HTMLElement) =>
  container.querySelector('.cross-detail') as HTMLElement;
const chip = (container: HTMLElement, label: string) =>
  all(container, '.trace-filter-chip').find((b) => b.textContent?.includes(label)) as
    | HTMLButtonElement
    | undefined;

describe('AnalysisStage 变更交叉分析', () => {
  it('按 JSON Pointer 展示影响矩阵并汇总各影响类型计数', () => {
    const { container } = setup();
    expect(container.textContent).toContain('变更交叉分析');
    expect(container.textContent).toContain('同路径冲突 1');
    expect(container.textContent).toContain('祖先覆盖交叉 1');
    expect(container.textContent).toContain('双方同改 1');
    expect(container.textContent).toContain('可自动合并 1');

    // 矩阵行：冲突 / 祖先交叉（祖先 × 后代路径）/ 双方同改 / 可自动合并
    const texts = rows(container).map((r) => r.textContent ?? '');
    expect(texts).toHaveLength(4);
    expect(texts[0]).toContain('同路径冲突');
    expect(texts[0]).toContain('/c');
    expect(texts[1]).toContain('祖先覆盖交叉');
    expect(texts[1]).toContain('/tree');
    expect(texts[1]).toContain('/tree/y');
    expect(texts[2]).toContain('双方同改');
    expect(texts[2]).toContain('/same');
    expect(texts[3]).toContain('可自动合并');
    expect(texts[3]).toContain('/free');
  });

  it('按影响类型筛选，计数为 0 的类型禁用', () => {
    const { container } = setup();
    act(() => chip(container, '同路径冲突')!.click());
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0].textContent).toContain('/c');

    // 再次点击「全部」恢复
    act(() => chip(container, '全部')!.click());
    expect(rows(container)).toHaveLength(4);

    // 无此类型时按钮禁用
    const { container: c2 } = setup({ a: 1 }, { a: 2 }, { a: 1 });
    expect(chip(c2, '同路径冲突')!.disabled).toBe(true);
    expect(chip(c2, '可自动合并')!.disabled).toBe(false);
  });

  it('点击路径定位三方值；祖先交叉同时展示被波及的后代路径', () => {
    const { container } = setup();
    // 点击冲突行：展示 /c 的三方值
    act(() => rows(container)[0].click());
    let detail = detailOf(container);
    expect(detail.textContent).toContain('/c');
    let values = all(detail, '.trace-value pre').map((p) => p.textContent);
    expect(values).toEqual(['1', '2', '3']);

    // 点击祖先交叉行：主路径 /tree + 后代路径 /tree/y 两组三方值
    act(() => rows(container)[1].click());
    detail = detailOf(container);
    expect(detail.textContent).toContain('/tree/y');
    expect(detail.textContent).toContain('被波及的后代路径');
    values = all(detail, '.trace-value pre').map((p) => p.textContent);
    expect(values).toHaveLength(6);
    expect(values[1]).toContain('gone'); // 当前分支整体替换为数组
    expect(values[5]).toBe('3'); // 目标分支把 /tree/y 改为 3
  });

  it('可自动合并条目标注变更类型；删除侧三方值显示（不存在）', () => {
    const { container } = setup(
      { a: 1, gone: { deep: true } },
      { a: 2 },
      { a: 1, gone: { deep: true } },
    );
    act(() => chip(container, '可自动合并')!.click());
    const autoRows = rows(container);
    expect(autoRows).toHaveLength(2);
    // /gone 为当前分支删除
    const goneRow = autoRows.find((r) => r.textContent?.includes('/gone'))!;
    act(() => goneRow.click());
    const detail = detailOf(container);
    expect(detail.textContent).toContain('当前分支 · 删除');
    const values = all(detail, '.trace-value').map((v) => v.textContent ?? '');
    expect(values[0]).toContain('deep'); // 基线仍有值
    expect(values[1]).toContain('（不存在）'); // 当前分支已删除
    expect(values[2]).toContain('deep'); // 目标分支保留
  });

  it('从分析结果继续进入合并流程；可返回输入', () => {
    const { container, calls } = setup();
    act(() => btnByText(container, '继续进入合并')!.click());
    expect(calls).toEqual(['merge']);
    act(() => btnByText(container, '返回输入')!.click());
    expect(calls).toEqual(['merge', 'back']);
  });

  it('三方一致时给出空态提示', () => {
    const { container } = setup({ a: 1 }, { a: 1 }, { a: 1 });
    expect(container.textContent).toContain('两侧相对基线均无变更');
    expect(rows(container)).toHaveLength(0);
  });
});
