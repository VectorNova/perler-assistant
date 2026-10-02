import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus, Scan } from 'lucide-react'
import { EMPTY, type Brand, type DimMode } from '../types'
import { PALETTE, codeOf, readableTextColor } from '../lib/color'

export type { DimMode }

interface Props {
  cells: Int16Array
  cols: number
  rows: number
  brand: Brand
  /** 当前选中的调色板下标；null 表示不强调任何颜色 */
  selected: number | null
  dimMode: DimMode
  done: ReadonlySet<number> | null
  /** 当前拼豆目标格 */
  targetCell: number | null
  /** 当前目标色块（会做半透明着色） */
  blobCells: number[] | null
  /** 识别置信度偏低、建议人工确认的格子 */
  warnCells?: ReadonlySet<number> | null
  showGrid: boolean
  showCodes: boolean
  sectionInterval: number
  showSectionLines: boolean
  extraDim?: boolean
  onCellClick?: (index: number) => void
  onHoverCell?: (index: number | null) => void
  /** token 变化时把 index 居中；给了 bounds 则缩放到该范围 */
  focusRequest?: {
    index: number
    token: number
    bounds?: { minR: number; minC: number; maxR: number; maxC: number }
  } | null
  /** token 变化时自适应缩放 */
  fitToken?: number
}

const EMPTY_CELL_FILL: [number, number, number] = [236, 238, 241]

export default function PatternCanvas(props: Props) {
  const {
    cells,
    cols,
    rows,
    brand,
    selected,
    dimMode,
    done,
    targetCell,
    blobCells,
    warnCells,
    showGrid,
    showCodes,
    sectionInterval,
    showSectionLines,
    onCellClick,
    onHoverCell,
    focusRequest,
    fitToken,
  } = props

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 640, h: 480 })
  const [view, setView] = useState({ scale: 16, tx: 0, ty: 0 })
  const viewRef = useRef(view)
  viewRef.current = view
  const sizeRef = useRef(size)
  sizeRef.current = size
  const fittedRef = useRef(true)
  const hoverRef = useRef<number | null>(null)

  /* ---------------- 图层（每格 1 像素，缩放时 drawImage 一次画完） ---------------- */

  const patternLayer = useMemo(() => {
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, cols)
    cv.height = Math.max(1, rows)
    const ctx = cv.getContext('2d')
    if (!ctx) return cv
    const img = ctx.createImageData(cv.width, cv.height)
    const d = img.data
    for (let i = 0; i < cells.length; i++) {
      const v = cells[i]
      const p = i * 4
      if (v === EMPTY || v < 0 || v >= PALETTE.length) {
        d[p] = EMPTY_CELL_FILL[0]
        d[p + 1] = EMPTY_CELL_FILL[1]
        d[p + 2] = EMPTY_CELL_FILL[2]
      } else {
        const rgb = PALETTE[v].rgb
        d[p] = rgb[0]
        d[p + 1] = rgb[1]
        d[p + 2] = rgb[2]
      }
      d[p + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    return cv
  }, [cells, cols, rows])

  const dimLayer = useMemo(() => {
    if (selected === null) return null
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, cols)
    cv.height = Math.max(1, rows)
    const ctx = cv.getContext('2d')
    if (!ctx) return null
    const img = ctx.createImageData(cv.width, cv.height)
    const d = img.data
    for (let i = 0; i < cells.length; i++) {
      const v = cells[i]
      const p = i * 4
      if (v === selected) {
        d[p + 3] = 0
        continue
      }
      if (dimMode === 'grayscale') {
        let r = EMPTY_CELL_FILL[0]
        let g = EMPTY_CELL_FILL[1]
        let b = EMPTY_CELL_FILL[2]
        if (v !== EMPTY && v >= 0 && v < PALETTE.length) {
          const rgb = PALETTE[v].rgb
          const y = Math.round(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2])
          r = y
          g = y
          b = y
        }
        d[p] = r
        d[p + 1] = g
        d[p + 2] = b
        d[p + 3] = 255
      } else if (dimMode === 'hide') {
        d[p] = 245
        d[p + 1] = 246
        d[p + 2] = 248
        d[p + 3] = 255
      } else {
        d[p] = 118
        d[p + 1] = 123
        d[p + 2] = 133
        d[p + 3] = 150
      }
    }
    ctx.putImageData(img, 0, 0)
    return cv
  }, [cells, cols, rows, selected, dimMode])

  /**
   * 「已完成」用中性色压暗，不用绿色。
   * 之前用半透明绿色蒙版，压在大片浅蓝格子上会形成一大块绿，
   * 和未完成区域撞色、很影响观感（而且绿色会被误读成图案本身的颜色）。
   * 改成中性压暗 + 带描边的对勾：不引入任何色相，浅色深色格子上都看得清。
   */
  const doneLayer = useMemo(() => {
    if (!done || done.size === 0) return null
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, cols)
    cv.height = Math.max(1, rows)
    const ctx = cv.getContext('2d')
    if (!ctx) return null
    const img = ctx.createImageData(cv.width, cv.height)
    const d = img.data
    for (const i of done) {
      if (i < 0 || i >= cells.length) continue
      const p = i * 4
      d[p] = 15
      d[p + 1] = 23
      d[p + 2] = 42
      d[p + 3] = 132
    }
    ctx.putImageData(img, 0, 0)
    return cv
  }, [done, cols, rows, cells.length])

  const blobLayer = useMemo(() => {
    if (!blobCells || blobCells.length === 0) return null
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, cols)
    cv.height = Math.max(1, rows)
    const ctx = cv.getContext('2d')
    if (!ctx) return null
    const img = ctx.createImageData(cv.width, cv.height)
    const d = img.data
    for (const i of blobCells) {
      if (i < 0 || i >= cells.length) continue
      const p = i * 4
      d[p] = 37
      d[p + 1] = 99
      d[p + 2] = 235
      d[p + 3] = 90
    }
    ctx.putImageData(img, 0, 0)
    return cv
  }, [blobCells, cols, rows, cells.length])

  /* ---------------- 尺寸自适应 ---------------- */

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      const next = { w: Math.max(80, r.width), h: Math.max(80, r.height) }
      const previous = sizeRef.current
      if (next.w === previous.w && next.h === previous.h) return
      sizeRef.current = next
      setSize(next)
      if (fittedRef.current) {
        const scale = Math.max(0.4, Math.min((next.w - 32) / cols, (next.h - 32) / rows))
        setView({ scale, tx: (next.w - cols * scale) / 2, ty: (next.h - rows * scale) / 2 })
      } else {
        // Preserve the viewed chart position when rotating or entering focus mode.
        setView((v) => ({ ...v, tx: v.tx + (next.w - previous.w) / 2, ty: v.ty + (next.h - previous.h) / 2 }))
      }
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [cols, rows])

  const fit = useCallback(() => {
    fittedRef.current = true
    const { w, h } = sizeRef.current
    const s = Math.max(0.4, Math.min((w - 32) / cols, (h - 32) / rows))
    setView({
      scale: s,
      tx: (w - cols * s) / 2,
      ty: (h - rows * s) / 2,
    })
  }, [cols, rows])

  // 首次布局 / 图纸变化时自动铺满
  useEffect(() => {
    fit()
  }, [fit, fitToken])

  const zoomBy = useCallback(
    (factor: number) => {
      fittedRef.current = false
      const { w, h } = sizeRef.current
      const v = viewRef.current
      const next = Math.max(0.4, Math.min(64, v.scale * factor))
      const k = next / v.scale
      setView({
        scale: next,
        tx: w / 2 - (w / 2 - v.tx) * k,
        ty: h / 2 - (h / 2 - v.ty) * k,
      })
    },
    [],
  )

  const centerOn = useCallback(
    (index: number, minScale = 14) => {
      if (index < 0 || index >= cells.length) return
      fittedRef.current = false
      const { w, h } = sizeRef.current
      const v = viewRef.current
      const r = Math.floor(index / cols)
      const c = index - r * cols
      const s = Math.max(v.scale, minScale)
      setView({
        scale: s,
        tx: w / 2 - (c + 0.5) * s,
        ty: h / 2 - (r + 0.5) * s,
      })
    },
    [cells.length, cols],
  )

  const fitBounds = useCallback(
    (b: { minR: number; minC: number; maxR: number; maxC: number }) => {
      fittedRef.current = false
      const { w, h } = sizeRef.current
      const bw = Math.max(1, b.maxC - b.minC + 1)
      const bh = Math.max(1, b.maxR - b.minR + 1)
      const s = Math.max(2, Math.min(48, Math.min((w - 44) / bw, (h - 44) / bh)))
      setView({
        scale: s,
        tx: w / 2 - ((b.minC + b.maxC + 1) / 2) * s,
        ty: h / 2 - ((b.minR + b.maxR + 1) / 2) * s,
      })
    },
    [],
  )

  const lastFocusToken = useRef(-1)
  useEffect(() => {
    if (!focusRequest) return
    if (focusRequest.token === lastFocusToken.current) return
    lastFocusToken.current = focusRequest.token
    if (focusRequest.bounds) fitBounds(focusRequest.bounds)
    else centerOn(focusRequest.index)
  }, [focusRequest, centerOn, fitBounds])

  /* ---------------- 绘制 ---------------- */

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
    ctx.fillStyle = '#f4f5f7'
    ctx.fillRect(0, 0, W, H)

    const { scale, tx, ty } = view
    const boardW = cols * scale
    const boardH = rows * scale

    // 板底阴影
    ctx.save()
    ctx.shadowColor = 'rgba(15, 23, 42, 0.18)'
    ctx.shadowBlur = 12
    ctx.shadowOffsetY = 3
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(tx, ty, boardW, boardH)
    ctx.restore()

    ctx.save()
    ctx.beginPath()
    ctx.rect(tx, ty, boardW, boardH)
    ctx.clip()
    ctx.translate(tx, ty)
    ctx.scale(scale, scale)
    // 放大时用最近邻保持色块边缘锐利；缩小时开启平滑避免丢细节
    ctx.imageSmoothingEnabled = scale < 1
    ctx.drawImage(patternLayer, 0, 0, cols, rows)
    if (dimLayer) ctx.drawImage(dimLayer, 0, 0, cols, rows)
    if (blobLayer) ctx.drawImage(blobLayer, 0, 0, cols, rows)
    if (doneLayer) ctx.drawImage(doneLayer, 0, 0, cols, rows)
    ctx.restore()

    // 可见范围（用于裁剪文字和勾选标记）
    const c0 = Math.max(0, Math.floor(-tx / scale))
    const c1 = Math.min(cols - 1, Math.ceil((W - tx) / scale))
    const r0 = Math.max(0, Math.floor(-ty / scale))
    const r1 = Math.min(rows - 1, Math.ceil((H - ty) / scale))

    // 单元格网格线
    if (showGrid && scale >= 4) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(tx, ty, boardW, boardH)
      ctx.clip()
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.16)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let c = c0; c <= c1 + 1; c++) {
        const x = Math.round(tx + c * scale) + 0.5
        ctx.moveTo(x, Math.max(ty, 0))
        ctx.lineTo(x, Math.min(ty + boardH, H))
      }
      for (let r = r0; r <= r1 + 1; r++) {
        const y = Math.round(ty + r * scale) + 0.5
        ctx.moveTo(Math.max(tx, 0), y)
        ctx.lineTo(Math.min(tx + boardW, W), y)
      }
      ctx.stroke()
      ctx.restore()
    }

    // 分区线：随缩放加粗 + 白色描边打底，保证压在任何格色上都看得清
    if (showSectionLines && sectionInterval > 0 && scale >= 2.5) {
      const visXs: number[] = []
      for (let c = 0; c <= cols; c += sectionInterval) {
        const x = tx + c * scale
        if (x >= -40 && x <= W + 40) visXs.push(c)
      }
      const visYs: number[] = []
      for (let r = 0; r <= rows; r += sectionInterval) {
        const y = ty + r * scale
        if (y >= -40 && y <= H + 40) visYs.push(r)
      }

      const buildPath = () => {
        ctx.beginPath()
        for (const c of visXs) {
          const x = Math.round(tx + c * scale) + 0.5
          ctx.moveTo(x, Math.max(ty, 0))
          ctx.lineTo(x, Math.min(ty + boardH, H))
        }
        for (const r of visYs) {
          const y = Math.round(ty + r * scale) + 0.5
          ctx.moveTo(Math.max(tx, 0), y)
          ctx.lineTo(Math.min(tx + boardW, W), y)
        }
      }
      ctx.save()
      ctx.beginPath()
      ctx.rect(tx, ty, boardW, boardH)
      ctx.clip()
      ctx.lineCap = 'butt'
      // 先画一圈白色底，再压深蓝主线
      buildPath()
      ctx.lineWidth = Math.max(2, scale * 0.2)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
      ctx.stroke()
      buildPath()
      ctx.lineWidth = Math.max(1, scale * 0.08)
      ctx.strokeStyle = '#1d4ed8'
      ctx.stroke()
      ctx.restore()
    }

    // 色号文字
    if (showCodes && scale >= 13) {
      const visible = (c1 - c0 + 1) * (r1 - r0 + 1)
      if (visible <= 8000) {
        const fontPx = Math.min(Math.round(scale * 0.4), 15)
        ctx.save()
        ctx.beginPath()
        ctx.rect(tx, ty, boardW, boardH)
        ctx.clip()
        ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        for (let r = r0; r <= r1; r++) {
          const cy = ty + (r + 0.5) * scale
          for (let c = c0; c <= c1; c++) {
            const v = cells[r * cols + c]
            if (v === EMPTY || v < 0 || v >= PALETTE.length) continue
            if (selected !== null && v !== selected && dimMode !== 'hide') {
              // 非当前颜色不标色号，减少干扰
              continue
            }
            if (dimMode === 'hide' && selected !== null && v !== selected) continue
            ctx.fillStyle = readableTextColor(PALETTE[v].rgb)
            ctx.fillText(codeOf(v, brand), tx + (c + 0.5) * scale, cy)
          }
        }
        ctx.restore()
      }
    }

    // 已完成格子的对勾（放大时才画，视口内才画）
    // 画两遍：先粗黑打底再白色，保证在浅色和深色格子上都清楚
    if (done && done.size > 0 && scale >= 9) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(tx, ty, boardW, boardH)
      ctx.clip()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const w = Math.max(1.4, scale * 0.11)
      const strokeChecks = () => {
        let drawn = 0
        ctx.beginPath()
        for (let r = r0; r <= r1 && drawn < 4000; r++) {
          for (let c = c0; c <= c1 && drawn < 4000; c++) {
            const i = r * cols + c
            if (!done.has(i)) continue
            drawn++
            const x = tx + c * scale
            const y = ty + r * scale
            ctx.moveTo(x + scale * 0.24, y + scale * 0.52)
            ctx.lineTo(x + scale * 0.43, y + scale * 0.72)
            ctx.lineTo(x + scale * 0.78, y + scale * 0.28)
          }
        }
        ctx.stroke()
      }
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'
      ctx.lineWidth = w * 2
      strokeChecks()
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.98)'
      ctx.lineWidth = w
      strokeChecks()
      ctx.restore()
    }

    // 图纸外框
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)'
    ctx.lineWidth = 1
    ctx.strokeRect(Math.round(tx) + 0.5, Math.round(ty) + 0.5, Math.round(boardW) - 1, Math.round(boardH) - 1)

    // 置信度偏低的格子：只在左上角点一个小三角
    // （早先用「整格虚框」，但高密度图纸几乎每格都偏低，整块画布会被橙色虚线淹没，
    //   连分区线都看不见了；改成角标记后既提示了位置又不抢视线）
    if (warnCells && warnCells.size > 0 && scale >= 6 && warnCells.size <= 1500) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(tx, ty, boardW, boardH)
      ctx.clip()
      ctx.fillStyle = 'rgba(217, 119, 6, 0.95)'
      const m = Math.max(3, Math.min(scale * 0.34, 10))
      let drawn = 0
      for (let r = r0; r <= r1 && drawn < 1500; r++) {
        for (let c = c0; c <= c1 && drawn < 1500; c++) {
          if (!warnCells.has(r * cols + c)) continue
          drawn++
          const x = tx + c * scale
          const y = ty + r * scale
          ctx.beginPath()
          ctx.moveTo(x, y)
          ctx.lineTo(x + m, y)
          ctx.lineTo(x, y + m)
          ctx.closePath()
          ctx.fill()
        }
      }
      ctx.restore()
    }

    // 当前色块：把「块的真实轮廓」描出来。
    // 只靠半透明平铺根本区分不出选中与未选中（其它格子已经被压暗成灰蓝了），
    // 所以这里描一圈边界：白色打底 + 亮红主线，任何底色上都跳得出来。
    if (blobCells && blobCells.length > 0) {
      const inRegion = new Set(blobCells)
      const path = new Path2D()
      for (const i of blobCells) {
        const r = Math.floor(i / cols)
        const c = i - r * cols
        if (r < r0 || r > r1 || c < c0 || c > c1) continue
        const x0 = tx + c * scale
        const y0 = ty + r * scale
        const x1 = x0 + scale
        const y1 = y0 + scale
        if (r === 0 || !inRegion.has(i - cols)) {
          path.moveTo(x0, y0)
          path.lineTo(x1, y0)
        }
        if (r === rows - 1 || !inRegion.has(i + cols)) {
          path.moveTo(x0, y1)
          path.lineTo(x1, y1)
        }
        if (c === 0 || !inRegion.has(i - 1)) {
          path.moveTo(x0, y0)
          path.lineTo(x0, y1)
        }
        if (c === cols - 1 || !inRegion.has(i + 1)) {
          path.moveTo(x1, y0)
          path.lineTo(x1, y1)
        }
      }
      ctx.save()
      ctx.beginPath()
      ctx.rect(tx, ty, boardW, boardH)
      ctx.clip()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
      ctx.lineWidth = Math.max(5, scale * 0.3)
      ctx.stroke(path)
      ctx.strokeStyle = '#e11d48'
      ctx.lineWidth = Math.max(2.5, scale * 0.15)
      ctx.stroke(path)
      ctx.restore()
    }

    // 悬停高亮
    const hv = hoverRef.current
    if (hv !== null && hv >= 0 && hv < cells.length) {
      const r = Math.floor(hv / cols)
      const c = hv - r * cols
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.75)'
      ctx.lineWidth = 2
      ctx.strokeRect(tx + c * scale + 1, ty + r * scale + 1, scale - 2, scale - 2)
    }

    // 分区线坐标尺：贴在视口上/左右边缘的「冻结表头」。
    // 放大后分区线可能滚出视野，靠这个随时知道自己在第几行第几列。
    // 缩到很小的时候（每格只有几像素）不画坐标尺：标签比格子还大，反而盖住图
    if (showSectionLines && sectionInterval > 0 && scale >= 6) {
      const chipH = 15
      // 坐标尺贴在图纸的上/左边缘附近；图纸边缘滚出视野时钉在视口边缘，
      // 这样既始终看得见，又不会离它标注的那条线太远
      const railY = Math.min(Math.max(ty, 0), Math.max(0, H - chipH))
      const railX = Math.min(Math.max(tx, 0), Math.max(0, W - 40))
      ctx.save()
      ctx.font = '600 10px ui-sans-serif, system-ui, "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      // 列号（贴图纸顶边）
      for (let c = 0; c <= cols; c += sectionInterval) {
        const x = tx + c * scale
        if (x < -20 || x > W + 20) continue
        const label = String(c + 1)
        const tw = ctx.measureText(label).width
        ctx.fillStyle = 'rgba(29, 78, 216, 0.92)'
        ctx.fillRect(x - tw / 2 - 4, railY, tw + 8, chipH)
        ctx.fillStyle = '#fff'
        ctx.fillText(label, x, railY + chipH / 2 + 0.5)
      }
      // 行号（贴图纸左边）
      for (let r = 0; r <= rows; r += sectionInterval) {
        const y = ty + r * scale
        if (y < -20 || y > H + 20) continue
        const label = String(r + 1)
        const tw = ctx.measureText(label).width
        ctx.fillStyle = 'rgba(29, 78, 216, 0.92)'
        ctx.fillRect(railX, y - chipH / 2, tw + 8, chipH)
        ctx.fillStyle = '#fff'
        ctx.fillText(label, railX + (tw + 8) / 2, y + 0.5)
      }
      ctx.restore()
    }
  }, [
    size,
    view,
    cols,
    rows,
    cells,
    patternLayer,
    dimLayer,
    blobLayer,
    doneLayer,
    done,
    showGrid,
    showCodes,
    selected,
    dimMode,
    brand,
    sectionInterval,
    showSectionLines,
    warnCells,
  ])

  /* ---------------- 交互 ---------------- */

  const hitTest = useCallback(
    (clientX: number, clientY: number): number => {
      const cv = canvasRef.current
      if (!cv) return -1
      const rect = cv.getBoundingClientRect()
      const v = viewRef.current
      const wx = (clientX - rect.left - v.tx) / v.scale
      const wy = (clientY - rect.top - v.ty) / v.scale
      const c = Math.floor(wx)
      const r = Math.floor(wy)
      if (c < 0 || r < 0 || c >= cols || r >= rows) return -1
      return r * cols + c
    },
    [cols, rows],
  )

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      fittedRef.current = false
      const rect = cv.getBoundingClientRect()
      const v = viewRef.current
      const factor = e.deltaY > 0 ? 1 / 1.14 : 1.14
      const next = Math.max(0.4, Math.min(64, v.scale * factor))
      const k = next / v.scale
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      setView({
        scale: next,
        tx: sx - (sx - v.tx) * k,
        ty: sy - (sy - v.ty) * k,
      })
    }
    cv.addEventListener('wheel', onWheel, { passive: false })
    return () => cv.removeEventListener('wheel', onWheel)
  }, [])

  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const drag = useRef({ moved: false, pinch: 0 })

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      ;(e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId)
    } catch {
      /* 合成事件（自动化测试）没有真实指针，忽略即可 */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) drag.current.moved = false
    if (pointers.current.size === 2) drag.current.pinch = 0
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const tracked = pointers.current.get(e.pointerId)
    if (!tracked) {
      const i = hitTest(e.clientX, e.clientY)
      if (i !== hoverRef.current) {
        hoverRef.current = i
        onHoverCell?.(i >= 0 ? i : null)
      }
      return
    }
    const dx = e.clientX - tracked.x
    const dy = e.clientY - tracked.y
    fittedRef.current = false
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointers.current.size >= 2) {
      const pts = [...pointers.current.values()]
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      if (drag.current.pinch > 0 && d > 0) {
        const cv = canvasRef.current
        const rect = cv ? cv.getBoundingClientRect() : null
        const v = viewRef.current
        const factor = d / drag.current.pinch
        const next = Math.max(0.4, Math.min(64, v.scale * factor))
        const k = next / v.scale
        const sx = rect ? (pts[0].x + pts[1].x) / 2 - rect.left : sizeRef.current.w / 2
        const sy = rect ? (pts[0].y + pts[1].y) / 2 - rect.top : sizeRef.current.h / 2
        setView({ scale: next, tx: sx - (sx - v.tx) * k, ty: sy - (sy - v.ty) * k })
      }
      drag.current.pinch = d
      drag.current.moved = true
      return
    }

    if (Math.abs(dx) + Math.abs(dy) > 0) drag.current.moved = true
    setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wasTracked = pointers.current.delete(e.pointerId)
    drag.current.pinch = 0
    if (wasTracked && pointers.current.size === 0 && !drag.current.moved) {
      const i = hitTest(e.clientX, e.clientY)
      if (i >= 0) onCellClick?.(i)
    }
  }

  const onPointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId)
    drag.current.pinch = 0
  }

  /* 当前目标格的脉冲标记：用 DOM 元素做，避免为了动画重绘画布 */
  let targetStyle: React.CSSProperties | null = null
  if (targetCell !== null && targetCell >= 0 && targetCell < cells.length) {
    const r = Math.floor(targetCell / cols)
    const c = targetCell - r * cols
    const s = Math.max(10, Math.min(view.scale, 60))
    targetStyle = {
      left: view.tx + (c + 0.5) * view.scale - s / 2,
      top: view.ty + (r + 0.5) * view.scale - s / 2,
      width: s,
      height: s,
    }
  }

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="pattern-canvas"
        style={{ width: size.w, height: size.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={() => zoomBy(1.8)}
      />
      {targetStyle && <div className="target-pulse" style={targetStyle} />}
      <div className="canvas-tools">
        <button type="button" onClick={() => zoomBy(1.25)} title="放大" aria-label="放大">
          <Plus size={18} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.25)} title="缩小" aria-label="缩小">
          <Minus size={18} aria-hidden="true" />
        </button>
        <button type="button" onClick={fit} title="适应窗口" aria-label="适应窗口">
          <Scan size={18} aria-hidden="true" />
        </button>
        <span className="zoom-label">{Math.round(view.scale)}px/格</span>
      </div>
    </div>
  )
}
