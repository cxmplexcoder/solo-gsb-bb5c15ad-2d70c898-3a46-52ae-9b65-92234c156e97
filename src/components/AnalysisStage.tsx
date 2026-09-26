import { useMemo, useState } from 'react';
import { getBySegments } from '../merge/pointer';
import { isAbsent, ABSENT, type JsonValue, type SideValue } from '../merge/types';
import {
  analyzeCrossImpact,
  IMPACT_FILTERS,
  IMPACT_LABEL,
  SIDE_CHANGE_LABEL,
  type ImpactEntry,
  type ImpactKind,
  type SideChange,
} from '../merge/crossAnalysis';

interface Props {
  base: JsonValue;
  ours: JsonValue;
  theirs: JsonValue;
  /** 从分析结果继续进入现有合并流程 */
  onProceedMerge: () => void;
  onBack: () => void;
}

/** 缺失（删除 / 从未存在）值的展示 */
function SideValueView({ label, value }: { label: string; value: SideValue }) {
  const absent = isAbsent(value);
  return (
    <div className={`trace-value${absent ? ' dim' : ''}`}>
      <h4>
        {label}
        {absent && <span className="absent-tag">缺失</span>}
      </h4>
      <pre>{absent ? '（不存在）' : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

/** 单侧变更徽标：新增 / 删除 / 修改 + 侧名 */
function ChangeTag({ label, change }: { label: string; change?: SideChange }) {
  if (!change) return null;
  return (
    <span className={`cross-change-tag ${change.kind}`}>
      {label}
      {SIDE_CHANGE_LABEL[change.kind]}
    </span>
  );
}

/** 输入阶段的「变更交叉分析」：按 JSON Pointer 展示两侧变更的影响矩阵 */
export default function AnalysisStage({ base, ours, theirs, onProceedMerge, onBack }: Props) {
  const analysis = useMemo(() => analyzeCrossImpact(base, ours, theirs), [base, ours, theirs]);
  const { counts } = analysis;

  const [active, setActive] = useState<ReadonlySet<ImpactKind>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const visible =
    active.size === 0 ? analysis.entries : analysis.entries.filter((e) => active.has(e.kind));
  const selected = analysis.entries.find((e) => e.id === selectedId) ?? null;

  const toggle = (key: ImpactKind) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 按路径段读取某侧文档的值；根为文档本身，读不到（删除 / 从未存在）为 ABSENT */
  const readAt = (doc: JsonValue, segments: string[]): SideValue =>
    segments.length === 0 ? doc : (getBySegments(doc, segments) ?? ABSENT);

  return (
    <>
      <div className="cross-panel">
        <div className="trace-header">
          <h3>变更交叉分析</h3>
          <span className="hint">
            基于基线分别计算两侧的结构化变更，按 JSON Pointer 交叉比对：同一路径冲突、祖先整体替换/删除
            × 后代修改、互不相干（可自动合并）；点击条目查看三方值
          </span>
        </div>
        <div className="trace-summary">
          当前分支 <strong>{analysis.oursChangeCount}</strong> 处变更 · 目标分支{' '}
          <strong>{analysis.theirsChangeCount}</strong> 处变更：同路径冲突 {counts.conflict} ·
          祖先覆盖交叉 {counts['ancestor-override']} · 双方同改 {counts['same-change']} · 可自动合并{' '}
          {counts['auto-merge']}
        </div>
        <div className="trace-filters">
          <button
            type="button"
            className={`small trace-filter-chip${active.size === 0 ? ' active' : ''}`}
            onClick={() => setActive(new Set())}
          >
            全部（{counts.total}）
          </button>
          {IMPACT_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`small trace-filter-chip impact-${f.key}${active.has(f.key) ? ' active' : ''}`}
              onClick={() => toggle(f.key)}
              disabled={counts[f.key] === 0}
              title={f.label}
            >
              {f.label}（{counts[f.key]}）
            </button>
          ))}
        </div>
        <div className="trace-list cross-list">
          {visible.length === 0 && (
            <div className="trace-empty">
              {analysis.entries.length === 0 ? '两侧相对基线均无变更' : '没有符合条件的条目'}
            </div>
          )}
          {visible.map((e) => (
            <button
              type="button"
              key={e.id}
              className={`trace-row cross-row impact-${e.kind}${selected?.id === e.id ? ' selected' : ''}`}
              onClick={() => setSelectedId(e.id)}
              title="点击查看该路径的基线 / 当前分支 / 目标分支三方值"
            >
              <span className={`impact-badge ${e.kind}`}>{IMPACT_LABEL[e.kind]}</span>
              <span className="cross-paths">
                <span className="trace-path">{e.pointer === '' ? '（根）' : e.pointer}</span>
                {e.relatedPointer !== undefined && (
                  <>
                    <span className="cross-times">×</span>
                    <span className="trace-path related">
                      {e.relatedPointer === '' ? '（根）' : e.relatedPointer}
                    </span>
                  </>
                )}
              </span>
              <span className="cross-reason">{e.reason}</span>
            </button>
          ))}
        </div>
        {selected && (
          <CrossDetail
            entry={selected}
            base={base}
            ours={ours}
            theirs={theirs}
            readAt={readAt}
          />
        )}
      </div>
      <div className="merge-footer">
        <button onClick={onBack}>← 返回输入</button>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="primary" onClick={onProceedMerge}>
          继续进入合并 →
        </button>
      </div>
    </>
  );
}

/** 选中条目的三方值详情：主路径（祖先交叉时另含被波及的后代路径）的基线 / 当前 / 目标值 */
function CrossDetail({
  entry,
  base,
  ours,
  theirs,
  readAt,
}: {
  entry: ImpactEntry;
  base: JsonValue;
  ours: JsonValue;
  theirs: JsonValue;
  readAt: (doc: JsonValue, segments: string[]) => SideValue;
}) {
  const segments = entry.segments;
  const related = entry.relatedSegments;
  return (
    <div className="trace-detail cross-detail">
      <div className="trace-detail-head">
        <span className="trace-detail-pointer">
          {entry.pointer === '' ? '（根节点）' : entry.pointer}
        </span>
        <span className={`impact-badge ${entry.kind}`}>{IMPACT_LABEL[entry.kind]}</span>
        <ChangeTag label="当前分支 · " change={entry.oursChange} />
        <ChangeTag label="目标分支 · " change={entry.theirsChange} />
      </div>
      <div className="cross-reason detail">{entry.reason}</div>
      <div className="trace-values three">
        <SideValueView label="基线" value={readAt(base, segments)} />
        <SideValueView label="当前分支" value={readAt(ours, segments)} />
        <SideValueView label="目标分支" value={readAt(theirs, segments)} />
      </div>
      {related && (
        <>
          <div className="trace-detail-head related-head">
            <span className="hint">被波及的后代路径</span>
            <span className="trace-detail-pointer">
              {entry.relatedPointer === '' ? '（根节点）' : entry.relatedPointer}
            </span>
          </div>
          <div className="trace-values three">
            <SideValueView label="基线" value={readAt(base, related)} />
            <SideValueView label="当前分支" value={readAt(ours, related)} />
            <SideValueView label="目标分支" value={readAt(theirs, related)} />
          </div>
        </>
      )}
    </div>
  );
}
