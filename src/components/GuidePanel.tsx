import type { Brand, ColorStep, Region, RegionOrderMode } from '../types'
import { PALETTE, codeOf, readableTextColor } from '../lib/color'
import { REGION_ORDER_OPTIONS } from '../lib/order'

type GuideUnit = 'region' | 'cell'

interface Props {
  brand: Brand
  steps: ColorStep[]
  stepIndex: number
  guideUnit: GuideUnit
  onGuideUnitChange: (u: GuideUnit) => void
  targetCell: number | null
  targetPos: { row: number; col: number } | null
  pendingInColor: number
  doneInColor: number
  regions: Region[]
  regionIndex: number
  regionDone: boolean[]
  doneRegions: number
  regionPending: number
  regionOrder: RegionOrderMode
  onRegionOrderChange: (m: RegionOrderMode) => void
  onPickRegion: (k: number) => void
  totalDone: number
  totalBeads: number
  elapsed: string
  onMarkRegion: () => void
  onMarkCurrent: () => void
  onMarkColor: () => void
  onUndo: () => void
  canUndo: boolean
  onLocate: () => void
  onSelectStep: (i: number) => void
  onNextColor: () => void
  onPrevColor: () => void
  onRestartColor: () => void
  autoAdvance: boolean
  onAutoAdvanceChange: (v: boolean) => void
}

export default function GuidePanel({
  brand,
  steps,
  stepIndex,
  guideUnit,
  onGuideUnitChange,
  targetCell,
  targetPos,
  pendingInColor,
  doneInColor,
  regions,
  regionIndex,
  regionDone,
  doneRegions,
  regionPending,
  regionOrder,
  onRegionOrderChange,
  onPickRegion,
  totalDone,
  totalBeads,
  elapsed,
  onMarkRegion,
  onMarkCurrent,
  onMarkColor,
  onUndo,
  canUndo,
  onLocate,
  onSelectStep,
  onNextColor,
  onPrevColor,
  onRestartColor,
  autoAdvance,
  onAutoAdvanceChange,
}: Props) {
  const step = steps[stepIndex]
  if (!step) {
    return (
      <div className="guide-panel">
        <div className="done-banner">🎉 全部拼完了！</div>
        <div className="muted">
          共 {totalBeads} 粒，用时 {elapsed}
        </div>
      </div>
    )
  }

  const entry = PALETTE[step.paletteIndex]
  const colorTotal = step.count
  const pct = colorTotal > 0 ? (doneInColor / colorTotal) * 100 : 0
  const overall = totalBeads > 0 ? (totalDone / totalBeads) * 100 : 0
  const currentRegion = regionIndex >= 0 ? regions[regionIndex] : null
  const regionCount = regions.length
  const isBigSingleBlock = regionCount === 1 && colorTotal > 1

  return (
    <div className="guide-panel">
      <div className="guide-header">
        <span className="guide-step-no">
          第 {stepIndex + 1} / {steps.length} 种颜色
        </span>
        <span className="muted small">用时 {elapsed}</span>
      </div>

      <div className="current-color-card">
        <div className="big-swatch" style={{ background: entry.hex, color: readableTextColor(entry.rgb) }}>
          <span className="big-code">{codeOf(step.paletteIndex, brand)}</span>
        </div>
        <div className="current-color-meta">
          <div className="big-hex">{entry.hex}</div>
          <div className="muted small">
            {colorTotal} 粒 · 已拼 {doneInColor} · 剩 {pendingInColor}
          </div>
          <div className="muted small">
            {regionCount} 块 · 已完成 {doneRegions} 块
          </div>
          <div className="bar">
            <div className="bar-fill color" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      <div className="unit-switch">
        <button
          type="button"
          className={guideUnit === 'region' ? 'active' : ''}
          onClick={() => onGuideUnitChange('region')}
        >
          按色块拼
        </button>
        <button
          type="button"
          className={guideUnit === 'cell' ? 'active' : ''}
          onClick={() => onGuideUnitChange('cell')}
        >
          按单粒拼
        </button>
      </div>

      {currentRegion ? (
        <div className="target-card">
          <div className="target-line">
            <span className="target-label">
              {isBigSingleBlock ? '当前这一整块' : `第 ${regionIndex + 1} / ${regionCount} 块`}
            </span>
            <span className="target-pos">{currentRegion.size} 粒</span>
          </div>
          <div className="muted small">
            第 {currentRegion.minR + 1}–{currentRegion.maxR + 1} 行 · 第 {currentRegion.minC + 1}–
            {currentRegion.maxC + 1} 列
            {regionPending < currentRegion.size && ` · 还差 ${regionPending} 粒`}
          </div>
          {guideUnit === 'cell' && targetPos && (
            <div className="muted small">
              下一粒：第 {targetPos.row + 1} 行 · 第 {targetPos.col + 1} 列
            </div>
          )}
          <button type="button" className="btn tiny" onClick={onLocate}>
            在图纸上居中显示
          </button>
        </div>
      ) : (
        <div className="target-card all-done">
          <span className="ok">这个颜色已经拼完了 ✅</span>
          {stepIndex < steps.length - 1 && (
            <button type="button" className="btn tiny primary" onClick={onNextColor}>
              去下一种颜色 →
            </button>
          )}
        </div>
      )}

      <div className="guide-actions">
        {guideUnit === 'region' ? (
          <>
            <button
              type="button"
              className="btn primary big"
              onClick={onMarkRegion}
              disabled={regionPending === 0}
              title="快捷键：空格 / B。也可以直接在图纸上点这一块里的任意一格"
            >
              ✓ 这一块拼好了{regionPending > 0 ? `（${regionPending} 粒）` : ''}
            </button>
            <p className="hint small">
              提示：在右边图纸上点这一块里的任意一格，同样会把整块标成完成；已完成的块再点一次可以取消。
            </p>
          </>
        ) : (
          <button
            type="button"
            className="btn primary big"
            onClick={onMarkCurrent}
            disabled={targetCell === null}
            title="快捷键：空格"
          >
            ✓ 拼好这一粒
          </button>
        )}
        <div className="btn-row">
          <button type="button" className="btn" onClick={onMarkColor} disabled={pendingInColor === 0}>
            整个颜色完成
          </button>
          <button type="button" className="btn" onClick={onUndo} disabled={!canUndo} title="快捷键：Ctrl+Z">
            ↶ 撤销
          </button>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={onRestartColor} disabled={doneInColor === 0}>
            重拼本颜色
          </button>
        </div>
      </div>

      <div className="overall">
        <div className="overall-line">
          <span>总进度</span>
          <span>
            {totalDone} / {totalBeads} 粒（{overall.toFixed(1)}%）
          </span>
        </div>
        <div className="bar tall">
          <div className="bar-fill" style={{ width: `${overall}%` }} />
        </div>
      </div>

      <div className="guide-nav">
        <button type="button" className="btn" onClick={onPrevColor} disabled={stepIndex === 0}>
          ← 上一种
        </button>
        <button
          type="button"
          className="btn"
          onClick={onNextColor}
          disabled={stepIndex >= steps.length - 1}
        >
          下一种 →
        </button>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={autoAdvance}
          onChange={(e) => onAutoAdvanceChange(e.target.checked)}
        />
        一个颜色拼完自动跳到下一种
      </label>

      <div className="region-block">
        <div className="region-head">
          <span className="muted small">拼块顺序</span>
          <select
            value={regionOrder}
            onChange={(e) => onRegionOrderChange(e.target.value as RegionOrderMode)}
          >
            {REGION_ORDER_OPTIONS.map((o) => (
              <option key={o.mode} value={o.mode}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="muted small">
          {REGION_ORDER_OPTIONS.find((o) => o.mode === regionOrder)?.hint ?? ''}
        </div>
        <div className="region-list">
          {regions.slice(0, 400).map((r, k) => (
            <button
              key={k}
              type="button"
              className={`region-chip ${k === regionIndex ? 'active' : ''} ${regionDone[k] ? 'done' : ''}`}
              onClick={() => onPickRegion(k)}
              title={`第 ${r.minR + 1}–${r.maxR + 1} 行 · 第 ${r.minC + 1}–${r.maxC + 1} 列`}
            >
              <span className="region-no">{k + 1}</span>
              {regionDone[k] ? '✓' : r.size}
            </button>
          ))}
          {regions.length > 400 && <span className="muted small">…共 {regions.length} 块</span>}
        </div>
      </div>

      <div className="step-list">
        {steps.map((s, i) => {
          const e2 = PALETTE[s.paletteIndex]
          return (
            <button
              key={s.paletteIndex}
              type="button"
              className={`step-row ${i === stepIndex ? 'active' : ''}`}
              onClick={() => onSelectStep(i)}
            >
              <span className="step-no">{i + 1}</span>
              <span className="swatch small" style={{ background: e2.hex }} />
              <span className="step-code">{codeOf(s.paletteIndex, brand)}</span>
              <span className="step-count">
                {s.regions.length}块 / {s.count}粒
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
