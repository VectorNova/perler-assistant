import type { Brand } from '../types'
import { PALETTE, codeOf } from '../lib/color'
import type { Plan } from '../types'
import type { ColorOrderMode } from '../types'

interface Props {
  plan: Plan
  raw: Map<number, number>
  brand: Brand
  selected: number | null
  onSelect: (index: number | null) => void
  excluded: Set<number>
  onToggleExclude: (index: number) => void
  doneCounts: Map<number, number>
  orderMode: ColorOrderMode
  onOrderMode: (m: ColorOrderMode) => void
  showExcluded: boolean
  onShowExcluded: (v: boolean) => void
  blankCells: number
  onExportCsv: () => void
  onExportPng: () => void
}

const ORDER_LABELS: { mode: ColorOrderMode; label: string }[] = [
  { mode: 'countDesc', label: '用量多→少' },
  { mode: 'countAsc', label: '用量少→多' },
  { mode: 'firstSeen', label: '按位置（左上优先）' },
  { mode: 'code', label: '按色号' },
]

export default function ColorList({
  plan,
  raw,
  brand,
  selected,
  onSelect,
  excluded,
  onToggleExclude,
  doneCounts,
  orderMode,
  onOrderMode,
  showExcluded,
  onShowExcluded,
  blankCells,
  onExportCsv,
  onExportPng,
}: Props) {
  const excludedList = [...excluded].filter((i) => raw.has(i))

  return (
    <div className="color-list">
      <div className="panel-head">
        <div className="panel-title">
          颜色分布
          <span className="muted">
            {plan.colors.length} 色 · {plan.total} 粒
            {plan.remapped > 0 && ` · 重映射 ${plan.remapped} 格`}
          </span>
        </div>
        <div className="panel-actions">
          <button type="button" className="btn tiny" onClick={onExportCsv}>
            导采购清单 CSV
          </button>
          <button type="button" className="btn tiny" onClick={onExportPng}>
            导清单图
          </button>
        </div>
      </div>

      <div className="order-row">
        <span className="muted small">颜色排序</span>
        <select value={orderMode} onChange={(e) => onOrderMode(e.target.value as ColorOrderMode)}>
          {ORDER_LABELS.map((o) => (
            <option key={o.mode} value={o.mode}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <button
        type="button"
        className={`color-row total ${selected === null ? 'active' : ''}`}
        onClick={() => onSelect(null)}
      >
        <span className="swatch rainbow" />
        <span className="color-main">
          <span className="code">全部颜色</span>
          <span className="hex">
            点这里取消高亮，显示整张图纸
            {blankCells > 0 && ` · 空格 ${blankCells}`}
          </span>
        </span>
        <span className="count">{plan.total}</span>
      </button>

      <div className="color-rows">
        {plan.colors.map((idx) => {
          const entry = PALETTE[idx]
          const total = plan.counts.get(idx) ?? 0
          const completed = doneCounts.get(idx) ?? 0
          const pct = total > 0 ? (completed / total) * 100 : 0
          const done = completed >= total
          return (
            <div
              key={idx}
              className={`color-row ${selected === idx ? 'active' : ''} ${done ? 'finished' : ''}`}
              onClick={() => onSelect(idx)}
            >
              <span className="swatch" style={{ background: entry.hex }} />
              <span className="color-main">
                <span className="code">
                  {codeOf(idx, brand)}
                  {done && <span className="badge-done">已完成</span>}
                </span>
                <span className="hex">
                  {entry.hex} · {total} 粒
                  {completed > 0 && !done && ` · 已拼 ${completed}`}
                </span>
                <span className="mini-bar">
                  <span className="mini-fill" style={{ width: `${pct}%` }} />
                </span>
              </span>
              <span className="count">{total}</span>
              <button
                type="button"
                className="icon-btn"
                title="我没有这个颜色，重映射到最接近的可用色"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleExclude(idx)
                }}
              >
                ⊘
              </button>
            </div>
          )
        })}
      </div>

      {excludedList.length > 0 && (
        <div className="excluded-block">
          <label className="checkbox">
            <input type="checkbox" checked={showExcluded} onChange={(e) => onShowExcluded(e.target.checked)} />
            已排除 {excludedList.length} 色（点 ⊘ 可恢复）
          </label>
          {showExcluded && (
            <div className="excluded-rows">
              {excludedList.map((idx) => (
                <button
                  key={idx}
                  type="button"
                  className="excluded-chip"
                  onClick={() => onToggleExclude(idx)}
                >
                  <span className="swatch small" style={{ background: PALETTE[idx].hex }} />
                  {codeOf(idx, brand)}
                  <span className="muted"> {raw.get(idx) ?? 0} 粒</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
