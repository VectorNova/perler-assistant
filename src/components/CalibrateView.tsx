import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GridSpec } from '../types'

interface Props {
  image: HTMLCanvasElement
  grid: GridSpec
  onChange: (g: GridSpec) => void
  onConfirm: () => void
  onAutoDetect: () => void
  /** 按图纸上标注的格数重算网格 */
  onApplyCellCount: (cols: number, rows: number) => void
  onDetectedHint: string | null
  /** 识别过程的诊断信息（剖面类型、自相关周期、拟合条数等） */
  debugText?: string | null
  preview: { colors: number; beads: number; blank: number } | null
  busy: boolean
}

type DragMode = 'view' | 'grid'

export default function CalibrateView({
  image,
  grid,
  onChange,
  onConfirm,
  onAutoDetect,
  onApplyCellCount,
  onDetectedHint,
  debugText,
  preview,
  busy,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ w: 640, h: 480 })
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 })
  const viewRef = useRef(view)
  viewRef.current = view
  const gridRef = useRef(grid)
  gridRef.current = grid
  const [mode, setMode] = useState<DragMode>('grid')
  const [showInset, setShowInset] = useState(true)
  const [countCols, setCountCols] = useState(String(grid.cols))
  const [countRows, setCountRows] = useState(String(grid.rows))
  const countInit = useRef(false)

  // 自动识别出新的行列数时，把格数输入框同步过去（用户没手动改过的话）
  useEffect(() => {
    if (!countInit.current) {
      countInit.current = true
      setCountCols(String(grid.cols))
      setCountRows(String(grid.rows))
    }
  }, [grid.cols, grid.rows])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize({ w: Math.max(80, r.width), h: Math.max(80, r.height) })
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    setSize({ w: Math.max(80, r.width), h: Math.max(80, r.height) })
    return () => ro.disconnect()
  }, [])

  const fit = useCallback(() => {
    const { w, h } = size
    const s = Math.min((w - 24) / image.width, (h - 24) / image.height)
    setView({ scale: s, tx: (w - image.width * s) / 2, ty: (h - image.height * s) / 2 })
  }, [size, image])

  useEffect(() => {
    fit()
    // 仅在容器尺寸变化时重新适应
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, image])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    const { w: W, h: H } = size
    const bw = Math.round(W * dpr)
    const bh = Math.round(H * dpr)
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw
      cv.height = bh
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#eef0f3'
    ctx.fillRect(0, 0, W, H)

    const { scale, tx, ty } = view
    ctx.save()
    ctx.imageSmoothingEnabled = scale < 1
    ctx.drawImage(image, tx, ty, image.width * scale, image.height * scale)
    ctx.restore()

    const g = grid
    const { cellW, cellH, offsetX, offsetY, cols, rows } = g
    const lineW = Math.max(0.4, 1 / scale)

    ctx.save()
    ctx.beginPath()
    ctx.rect(tx, ty, image.width * scale, image.height * scale)
    ctx.clip()

    // 采样区域（内缩 20%），直观看到每格采的是哪块像素
    if (showInset && cellW * scale >= 9 && cellH * scale >= 9 && cols * rows <= 20000) {
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.55)'
      ctx.lineWidth = lineW
      ctx.beginPath()
      const ix = Math.max(1, cellW * 0.2)
      const iy = Math.max(1, cellH * 0.2)
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x0 = tx + (offsetX + c * cellW + ix) * scale
          const y0 = ty + (offsetY + r * cellH + iy) * scale
          const x1 = tx + (offsetX + (c + 1) * cellW - ix) * scale
          const y1 = ty + (offsetY + (r + 1) * cellH - iy) * scale
          if (x1 < 0 || y1 < 0 || x0 > W || y0 > H) continue
          ctx.rect(x0, y0, x1 - x0, y1 - y0)
        }
      }
      ctx.stroke()
    }

    // 网格线：每 5 格加粗
    for (let i = 0; i <= cols; i++) {
      const x = Math.round(tx + (offsetX + i * cellW) * scale) + 0.5
      ctx.strokeStyle = i % 5 === 0 ? 'rgba(220, 38, 38, 0.95)' : 'rgba(37, 99, 235, 0.6)'
      ctx.lineWidth = i % 5 === 0 ? 1.8 : 1
      ctx.beginPath()
      ctx.moveTo(x, ty + offsetY * scale)
      ctx.lineTo(x, ty + (offsetY + rows * cellH) * scale)
      ctx.stroke()
    }
    for (let i = 0; i <= rows; i++) {
      const y = Math.round(ty + (offsetY + i * cellH) * scale) + 0.5
      ctx.strokeStyle = i % 5 === 0 ? 'rgba(220, 38, 38, 0.95)' : 'rgba(37, 99, 235, 0.6)'
      ctx.lineWidth = i % 5 === 0 ? 1.8 : 1
      ctx.beginPath()
      ctx.moveTo(tx + offsetX * scale, y)
      ctx.lineTo(tx + (offsetX + cols * cellW) * scale, y)
      ctx.stroke()
    }

    // 网格原点标记
    const ox = tx + offsetX * scale
    const oy = ty + offsetY * scale
    ctx.fillStyle = 'rgba(220, 38, 38, 0.95)'
    ctx.beginPath()
    ctx.arc(ox, oy, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    ctx.strokeStyle = 'rgba(220, 38, 38, 0.9)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(
      tx + offsetX * scale,
      ty + offsetY * scale,
      cols * cellW * scale,
      rows * cellH * scale,
    )
  }, [size, view, grid, image, showInset])

  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const drag = useRef({ moved: false, pinch: 0 })

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 合成事件没有真实指针 */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) drag.current.moved = false
    if (pointers.current.size === 2) drag.current.pinch = 0
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const tracked = pointers.current.get(e.pointerId)
    if (!tracked) return
    const dx = e.clientX - tracked.x
    const dy = e.clientY - tracked.y
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointers.current.size >= 2) {
      const pts = [...pointers.current.values()]
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      if (drag.current.pinch > 0 && d > 0) {
        const v = viewRef.current
        const next = Math.max(0.05, Math.min(40, v.scale * (d / drag.current.pinch)))
        const k = next / v.scale
        const rect = canvasRef.current?.getBoundingClientRect()
        const sx = rect ? (pts[0].x + pts[1].x) / 2 - rect.left : size.w / 2
        const sy = rect ? (pts[0].y + pts[1].y) / 2 - rect.top : size.h / 2
        setView({ scale: next, tx: sx - (sx - v.tx) * k, ty: sy - (sy - v.ty) * k })
      }
      drag.current.pinch = d
      drag.current.moved = true
      return
    }

    if (Math.abs(dx) + Math.abs(dy) > 0) drag.current.moved = true
    if (mode === 'view') {
      setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }))
    } else {
      const v = viewRef.current
      const g = gridRef.current
      onChange({
        ...g,
        offsetX: +(g.offsetX + dx / v.scale).toFixed(2),
        offsetY: +(g.offsetY + dy / v.scale).toFixed(2),
      })
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId)
    drag.current.pinch = 0
  }

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = cv.getBoundingClientRect()
      const v = viewRef.current
      const next = Math.max(0.05, Math.min(40, v.scale * (e.deltaY > 0 ? 1 / 1.15 : 1.15)))
      const k = next / v.scale
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      setView({ scale: next, tx: sx - (sx - v.tx) * k, ty: sy - (sy - v.ty) * k })
    }
    cv.addEventListener('wheel', onWheel, { passive: false })
    return () => cv.removeEventListener('wheel', onWheel)
  }, [])

  const nudge = (dx: number, dy: number) => {
    onChange({ ...grid, offsetX: +(grid.offsetX + dx).toFixed(2), offsetY: +(grid.offsetY + dy).toFixed(2) })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      nudge(-step, 0)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      nudge(step, 0)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      nudge(0, -step)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      nudge(0, step)
    }
  }

  const setNum = (patch: Partial<GridSpec>) => onChange({ ...grid, ...patch })

  const num = (label: string, key: keyof GridSpec, step = 1, min = -100000, max = 100000) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={Number.isInteger(grid[key]) ? grid[key] : +grid[key].toFixed(2)}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) setNum({ [key]: v } as Partial<GridSpec>)
        }}
      />
    </label>
  )

  const summary = useMemo(
    () => `${grid.cols} 列 × ${grid.rows} 行 = ${grid.cols * grid.rows} 格`,
    [grid.cols, grid.rows],
  )

  return (
    <div className="calibrate">
      <div className="calibrate-stage" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown}>
        <canvas
          ref={canvasRef}
          className="pattern-canvas"
          style={{ width: size.w, height: size.h }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <div className="canvas-tools">
          <button
            type="button"
            className={mode === 'grid' ? 'active' : ''}
            onClick={() => setMode('grid')}
            title="拖动鼠标移动整个网格（校准原点）"
          >
            移动网格
          </button>
          <button
            type="button"
            className={mode === 'view' ? 'active' : ''}
            onClick={() => setMode('view')}
            title="拖动鼠标平移视图"
          >
            平移视图
          </button>
          <button type="button" onClick={() => setView((v) => ({ ...v, scale: v.scale * 1.25 }))}>
            ＋
          </button>
          <button type="button" onClick={() => setView((v) => ({ ...v, scale: v.scale / 1.25 }))}>
            －
          </button>
          <button type="button" onClick={fit}>
            ⤢
          </button>
          <span className="zoom-label">{Math.round(view.scale * 100)}%</span>
        </div>
      </div>

      <aside className="calibrate-panel">
        <h2>① 校准网格</h2>
        <p className="hint">
          自动识别已经给出一个初值。用「移动网格」拖动，或用方向键微调（Shift + 方向键 = 10px），
          让红线正好压在图纸的网格线上。
        </p>

        <div className="btn-row">
          <button type="button" className="btn" onClick={onAutoDetect} disabled={busy}>
            重新自动识别
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              setNum({ offsetX: 0, offsetY: 0, cellW: 20, cellH: 20, cols: Math.round(image.width / 20), rows: Math.round(image.height / 20) })
            }
          >
            重置
          </button>
        </div>
        {onDetectedHint && <div className="detect-hint">{onDetectedHint}</div>}

        <div className="count-calibrate">
          <div className="count-title">按图纸标注的格数校准（最可靠）</div>
          <p className="hint small">
            图纸标题/角落一般直接写着格数，例如「104x104/38色/共10816颗」。
            填进去后，格距就是「图案宽度 ÷ 格数」，不必再靠算法猜。
          </p>
          <div className="count-row">
            <label className="field">
              <span>列数</span>
              <input
                type="number"
                min={1}
                max={600}
                value={countCols}
                onChange={(e) => setCountCols(e.target.value)}
              />
            </label>
            <span className="count-x">×</span>
            <label className="field">
              <span>行数</span>
              <input
                type="number"
                min={1}
                max={600}
                value={countRows}
                onChange={(e) => setCountRows(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                const c = parseInt(countCols, 10)
                const r = parseInt(countRows, 10)
                if (c > 0 && r > 0) onApplyCellCount(c, r)
              }}
            >
              按格数重算
            </button>
          </div>
        </div>

        {debugText && (
          <details className="debug-details">
            <summary>识别过程诊断</summary>
            <div className="debug-body">{debugText}</div>
          </details>
        )}

        <div className="grid-form">
          {num('格宽 cellW', 'cellW', 0.5, 1)}
          {num('格高 cellH', 'cellH', 0.5, 1)}
          {num('原点 X', 'offsetX', 1)}
          {num('原点 Y', 'offsetY', 1)}
          {num('列数 cols', 'cols', 1, 1, 400)}
          {num('行数 rows', 'rows', 1, 1, 400)}
        </div>

        <div className="preset-row">
          <span className="hint small">格宽微调</span>
          <button type="button" className="btn tiny" onClick={() => setNum({ cellW: +(grid.cellW - 0.1).toFixed(2), cellH: +(grid.cellH - 0.1).toFixed(2) })}>
            −0.1
          </button>
          <button type="button" className="btn tiny" onClick={() => setNum({ cellW: +(grid.cellW + 0.1).toFixed(2), cellH: +(grid.cellH + 0.1).toFixed(2) })}>
            +0.1
          </button>
          <button type="button" className="btn tiny" onClick={() => setNum({ cols: grid.cols + 1 })}>
            列 +1
          </button>
          <button type="button" className="btn tiny" onClick={() => setNum({ cols: Math.max(1, grid.cols - 1) })}>
            列 −1
          </button>
          <button type="button" className="btn tiny" onClick={() => setNum({ rows: grid.rows + 1 })}>
            行 +1
          </button>
          <button type="button" className="btn tiny" onClick={() => setNum({ rows: Math.max(1, grid.rows - 1) })}>
            行 −1
          </button>
        </div>

        <label className="checkbox">
          <input type="checkbox" checked={showInset} onChange={(e) => setShowInset(e.target.checked)} />
          显示每格的采样区域
        </label>

        <div className="summary">
          <div>
            <strong>{summary}</strong>
          </div>
          {preview && (
            <div className="preview-line">
              预览识别：<b>{preview.colors}</b> 种颜色 · <b>{preview.beads}</b> 粒豆子 ·{' '}
              <b>{preview.blank}</b> 个空格
              {preview.colors > 1 && <span className="ok"> · 看起来对上了</span>}
            </div>
          )}
        </div>

        <button type="button" className="btn primary big" onClick={onConfirm} disabled={busy}>
          {busy ? '识别中…' : '② 开始识别图纸'}
        </button>
      </aside>
    </div>
  )
}
