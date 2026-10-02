import { useEffect, useRef, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronUp, Undo2 } from 'lucide-react'
import { readableTextColor } from '../lib/color'
import './mobile-drawer.css'

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
  guideUnit: 'region' | 'cell'
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
  guideUnit,
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
  const drawerRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!expanded) return
    const previousFocus = document.activeElement as HTMLElement | null
    drawerRef.current?.querySelector<HTMLButtonElement>('.m-tab.on')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onExpanded(false)
      if (event.key !== 'Tab') return
      const controls = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      ) ?? []).filter((element) => element.getClientRects().length > 0)
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [expanded, onExpanded])

  const pick = (key: MobileSheet) => {
    if (key === sheet) {
      onExpanded(!expanded)
      return
    }
    onSheet(key)
    // The guide is useful in its compact form; every other sheet opens.
    onExpanded(key !== 'guide')
  }

  const showCompact = !expanded
  return (
    <>
      {expanded && (
        <button
          type="button"
          className="m-drawer-backdrop"
          aria-label="关闭控制面板"
          onClick={() => onExpanded(false)}
        />
      )}
      <section
        ref={drawerRef}
        className={`m-drawer ${expanded ? 'expanded' : 'collapsed'}`}
        role={expanded ? 'dialog' : 'region'}
        aria-modal={expanded || undefined}
        aria-label="图纸控制面板"
      >
        <div className="m-drawer-tabs" role="tablist" aria-label="图纸工具">
          {TABS.map((t) => (
            <button
              key={t.key}
              id={`mobile-tab-${t.key}`}
              type="button"
              className={`m-tab ${sheet === t.key ? 'on' : ''}`}
              onClick={() => pick(t.key)}
              role="tab"
              aria-selected={sheet === t.key}
              aria-controls={expanded && sheet === t.key ? `mobile-sheet-${t.key}` : undefined}
            >
              {t.label}
            </button>
          ))}
          <button
            type="button"
            className="m-drawer-toggle"
            onClick={() => onExpanded(!expanded)}
            title={expanded ? '收起控制面板' : '展开控制面板'}
            aria-label={expanded ? '收起控制面板' : '展开控制面板'}
            aria-expanded={expanded}
            aria-controls={expanded ? `mobile-sheet-${sheet}` : undefined}
          >
            {expanded ? <ChevronDown size={20} aria-hidden="true" /> : <ChevronUp size={20} aria-hidden="true" />}
          </button>
        </div>

      {showCompact && (
        <div className="m-compact">
          {guideActive && stepCount > 0 ? (
            <div className="m-compact-line">
              <div className="m-compact-status" aria-live="polite">
                <span
                  className="m-compact-code"
                  style={{ background: hex, color: readableTextColor(hexToRgbSafe(hex)) }}
                >
                  {code}
                </span>
                <span className="m-compact-meta">
                  <span>第 {stepNo}/{stepCount} 色</span>
                  <span>{regionIndex < 0 ? '本色已完成' : `块 ${regionIndex + 1}/${regionCount}`}</span>
                  <span>{guideUnit === 'cell' ? (canMark ? 1 : 0) : regionPending} 粒待拼</span>
                </span>
              </div>
              <button
                type="button"
                className="m-compact-complete btn primary"
                onClick={onMarkRegion}
                disabled={!canMark}
                title={guideUnit === 'cell' ? '这一粒拼好了' : '这一块拼好了'}
                aria-label={guideUnit === 'cell' ? '这一粒拼好了' : '这一块拼好了'}
              >
                <Check size={18} aria-hidden="true" /> 完成
              </button>
              <button
                type="button"
                className="m-compact-undo btn"
                onClick={onUndo}
                disabled={!canUndo}
                title="撤销"
                aria-label="撤销"
              >
                <Undo2 size={19} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <button type="button" className="m-compact-start btn primary" onClick={onStartGuide}>
              开始拼豆指引
            </button>
          )}
        </div>
      )}

      {expanded && (
        <div className="m-drawer-body" id={`mobile-sheet-${sheet}`} role="tabpanel" aria-labelledby={`mobile-tab-${sheet}`}>
          {children}
        </div>
      )}
      </section>
    </>
  )
}

/** 把 '#rrggbb' 解析成 RGB；解析不出来就用黑色（只影响对勾文字颜色） */
function hexToRgbSafe(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
