import type { ReactNode } from 'react'
import { readableTextColor } from '../lib/color'

export type MobileSheet = 'guide' | 'colors' | 'display' | 'info'

const TABS: { key: MobileSheet; label: string }[] = [
  { key: 'guide', label: '指引' },
  { key: 'colors', label: '颜色' },
  { key: 'display', label: '显示' },
  { key: 'info', label: '图纸' },
]

interface Props {
  sheet: MobileSheet
  onSheet: (s: MobileSheet) => void
  expanded: boolean
  onExpanded: (v: boolean) => void

  /** 拼豆指引是否已开始（没开始时收起态只显示一个「开始」按钮） */
  guideActive: boolean
  onStartGuide: () => void

  stepNo: number
  stepCount: number
  code: string
  hex: string
  regionIndex: number
  regionCount: number
  regionPending: number
  canMark: boolean
  canUndo: boolean
  onMarkRegion: () => void
  onUndo: () => void

  /** 展开时显示的完整面板 */
  children: ReactNode
}

/**
 * 手机端底部抽屉。
 *
 * 设计取舍：
 *  - **标签栏常驻**，内容区默认收起。收起时画布能占满剩下的屏幕，
 *    而拼豆时最关键的三个信息（当前色号 / 这一块多少粒 / 「拼好了」按钮）
 *    都压在收起态里，不用展开就能操作。
 *  - 点非「指引」的标签会自动展开（那些面板收起时没意义）；
 *    点已激活的「指引」标签才在展开/收起之间切换。
 *  - 「颜色」和「指引」直接对应原来的看颜色分布 / 拼豆指引两种模式，
 *    手机上不再需要单独的「模式切换」按钮。
 */
export default function MobileDrawer({
  sheet,
  onSheet,
  expanded,
  onExpanded,
  guideActive,
  onStartGuide,
  stepNo,
  stepCount,
  code,
  hex,
  regionIndex,
  regionCount,
  regionPending,
  canMark,
  canUndo,
  onMarkRegion,
  onUndo,
  children,
}: Props) {
  const pick = (key: MobileSheet) => {
    if (key === sheet) {
      if (key === 'guide') onExpanded(!expanded)
      return
    }
    onSheet(key)
    onExpanded(key !== 'guide')
  }

  const showCompact = !expanded && sheet === 'guide'

  return (
    <div className={`m-drawer ${expanded ? 'expanded' : ''}`}>
      <div className="m-drawer-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`m-tab ${sheet === t.key ? 'on' : ''}`}
            onClick={() => pick(t.key)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className="m-drawer-toggle"
          onClick={() => onExpanded(!expanded)}
          title={expanded ? '收起' : '展开'}
          aria-expanded={expanded}
        >
          {expanded ? '▾ 收起' : '▴ 展开'}
        </button>
      </div>

      {showCompact && (
        <div className="m-compact">
          {guideActive && stepCount > 0 ? (
            <>
              <div className="m-compact-line">
                <span
                  className="m-compact-code"
                  style={{ background: hex, color: readableTextColor(hexToRgbSafe(hex)) }}
                >
                  {code}
                </span>
                <span className="muted small">
                  第 {stepNo}/{stepCount} 种 · 第 {regionIndex + 1}/{regionCount} 块 ·{' '}
                  <b>{regionPending}</b> 粒
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn tiny"
                  onClick={onUndo}
                  disabled={!canUndo}
                  title="撤销"
                >
                  ↶
                </button>
              </div>
              <button
                type="button"
                className="btn primary big block"
                onClick={onMarkRegion}
                disabled={!canMark}
              >
                ✓ 这一块拼好了（{regionPending} 粒）
              </button>
            </>
          ) : (
            <button type="button" className="btn primary big block" onClick={onStartGuide}>
              开始拼豆指引
            </button>
          )}
        </div>
      )}

      {expanded && <div className="m-drawer-body">{children}</div>}
    </div>
  )
}

/** 把 '#rrggbb' 解析成 RGB；解析不出来就用黑色（只影响对勾文字颜色） */
function hexToRgbSafe(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
