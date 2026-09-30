import type { CellOrderMode, DimMode, RegionOrderMode } from '../types'
import { CELL_ORDER_OPTIONS, REGION_ORDER_OPTIONS } from '../lib/order'

interface Props {
  dimMode: DimMode
  onDimMode: (m: DimMode) => void
  regionOrder: RegionOrderMode
  onRegionOrder: (m: RegionOrderMode) => void
  cellOrder: CellOrderMode
  onCellOrder: (m: CellOrderMode) => void
  treatBlankAsEmpty: boolean
  onTreatBlankAsEmpty: (v: boolean) => void
  blankCells: number
  sectionInterval: number
  onSectionInterval: (n: number) => void
  focusOnColor: boolean
  onFocusOnColor: (v: boolean) => void
  onResetProgress: () => void
}

/**
 * 「显示」面板。
 * 桌面端放在右栏、移动端放在底部抽屉里，两边共用同一份，避免改一处漏一处。
 */
export default function DisplaySettings({
  dimMode,
  onDimMode,
  regionOrder,
  onRegionOrder,
  cellOrder,
  onCellOrder,
  treatBlankAsEmpty,
  onTreatBlankAsEmpty,
  blankCells,
  sectionInterval,
  onSectionInterval,
  focusOnColor,
  onFocusOnColor,
  onResetProgress,
}: Props) {
  return (
    <div className="settings">
      <h3>未选中颜色怎么显示</h3>
      <div className="radio-row">
        {(
          [
            ['dim', '压暗（保留轮廓）'],
            ['grayscale', '转灰度'],
            ['hide', '隐藏（只留当前色）'],
          ] as [DimMode, string][]
        ).map(([m, label]) => (
          <label key={m} className="radio">
            <input
              type="radio"
              name="dimmode"
              checked={dimMode === m}
              onChange={() => onDimMode(m)}
            />
            {label}
          </label>
        ))}
      </div>

      <h3>拼块顺序（块与块之间）</h3>
      <select value={regionOrder} onChange={(e) => onRegionOrder(e.target.value as RegionOrderMode)}>
        {REGION_ORDER_OPTIONS.map((o) => (
          <option key={o.mode} value={o.mode}>
            {o.label} —— {o.hint}
          </option>
        ))}
      </select>

      <h3>一块之内的下笔顺序</h3>
      <select value={cellOrder} onChange={(e) => onCellOrder(e.target.value as CellOrderMode)}>
        {CELL_ORDER_OPTIONS.map((o) => (
          <option key={o.mode} value={o.mode}>
            {o.label}
          </option>
        ))}
      </select>

      <h3>空白格</h3>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={treatBlankAsEmpty}
          onChange={(e) => onTreatBlankAsEmpty(e.target.checked)}
        />
        把贴边空白当作「不拼」（{blankCells} 格）
      </label>
      <p className="hint small">
        自动判断依据是「颜色接近纸面背景 + 与图纸外沿连通」。关掉后这些格子会按识别出的
        颜色算作豆子 —— 图纸边缘的白色豆子被误判时用得上。
      </p>

      <h3>分区线间隔</h3>
      <div className="row-inline">
        <input
          type="range"
          min={5}
          max={50}
          step={1}
          value={sectionInterval}
          onChange={(e) => onSectionInterval(parseInt(e.target.value, 10))}
        />
        <span className="muted small">每 {sectionInterval} 格</span>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={focusOnColor}
          onChange={(e) => onFocusOnColor(e.target.checked)}
        />
        点击颜色时自动缩放到该颜色的范围
      </label>

      <h3>进度</h3>
      <div className="btn-row">
        <button type="button" className="btn" onClick={onResetProgress}>
          清空已拼标记
        </button>
      </div>
    </div>
  )
}
