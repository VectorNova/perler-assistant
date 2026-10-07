import type { GridSpec, RGB } from '../types'

/** 图例色块的原图坐标；仅提供几何和填色，不推断色号。 */
export interface ChartLegendSwatch {
  x: number
  y: number
  w: number
  h: number
  rgb: RGB
}

export interface ChartLegendGeometry {
  /** 按先行后列的阅读顺序排列，包含有边框的白色色块。 */
  swatches: ChartLegendSwatch[]
  confidence: number
  layout: 'below' | 'right'
}

interface Component {
  x: number
  y: number
  w: number
  h: number
  area: number
  rgb: RGB
}

interface LegendRow {
  members: Component[]
  y: number
  w: number
  h: number
}

interface RowModel {
  centerX: number
  pitchX: number
  w: number
  h: number
}

const median = (values: number[]) => {
  values.sort((a, b) => a - b)
  return values[values.length >> 1] ?? 0
}

const colorDistance = (a: RGB, b: RGB) =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

/** 少数文字和水印不参与填色；在矩形内部按通道取中位数。 */
function rectangleColor(img: ImageData, rect: { x: number; y: number; w: number; h: number }): RGB {
  const colors: number[][] = [[], [], []]
  const inset = Math.max(1, Math.round(Math.min(rect.w, rect.h) * 0.12))
  const step = Math.max(1, Math.floor(Math.min(rect.w, rect.h) / 20))
  for (let y = rect.y + inset; y < rect.y + rect.h - inset; y += step) {
    for (let x = rect.x + inset; x < rect.x + rect.w - inset; x += step) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue
      const p = (y * img.width + x) * 4
      for (let c = 0; c < 3; c++) colors[c].push(img.data[p + c])
    }
  }
  return [median(colors[0]), median(colors[1]), median(colors[2])]
}

/** 同一排必须有多种填色，坐标栏虽然规则，但只有一种底色。 */
function groupRows(candidates: Component[], step: number): LegendRow[] {
  const groups: Component[][] = []
  for (const candidate of [...candidates].sort((a, b) => a.y - b.y)) {
    const row = groups.find((members) => {
      const first = members[0]
      return Math.abs(first.y - candidate.y) <= Math.max(step * 3, first.h * 0.2)
        && Math.abs(first.h - candidate.h) <= Math.max(step * 3, first.h * 0.35)
    })
    if (row) row.push(candidate)
    else groups.push([candidate])
  }
  return groups.flatMap((members) => {
    const w = median(members.map((c) => c.w)), h = median(members.map((c) => c.h))
    // 水印可把一个填色块切成碎片；只用接近主尺寸的部分拟合周期。
    const regular = members.filter((c) => c.w >= w * 0.84 && c.w <= w * 1.2 && c.h >= h * 0.75)
      .sort((a, b) => a.x - b.x)
    const colors: RGB[] = []
    for (const candidate of regular) {
      if (colors.every((color) => colorDistance(color, candidate.rgb) > 20)) colors.push(candidate.rgb)
    }
    if (regular.length < 3 || colors.length < 3) return []
    return [{ members: regular, y: median(regular.map((c) => c.y)), w, h }]
  })
}

/** 用整数倍间距容忍漏掉的白块，再对共线中心做线性拟合。 */
function fitRow(row: LegendRow, step: number): RowModel | null {
  const centers = row.members.map((c) => c.x + c.w / 2)
  const differences = centers.slice(1).map((x, i) => x - centers[i]).filter((d) => d >= row.w * 0.9)
  const pitchX = median(differences)
  if (pitchX < row.w * 0.95 || pitchX > row.w * 4 || differences.length < 2) return null
  const tolerance = Math.max(step * 2.5, row.w * 0.08)
  const origin = centers[0]
  const points = centers.map((x) => ({ x, col: Math.round((x - origin) / pitchX) }))
    .filter((p) => Math.abs(p.x - origin - p.col * pitchX) <= tolerance)
  if (points.length < Math.max(3, row.members.length * 0.85)) return null
  const meanCol = points.reduce((s, p) => s + p.col, 0) / points.length
  const meanX = points.reduce((s, p) => s + p.x, 0) / points.length
  const denominator = points.reduce((s, p) => s + (p.col - meanCol) ** 2, 0)
  if (!denominator) return null
  const fitPitch = points.reduce((s, p) => s + (p.col - meanCol) * (p.x - meanX), 0) / denominator
  const centerX = meanX - fitPitch * meanCol
  if (points.some((p) => Math.abs(p.x - centerX - p.col * fitPitch) > tolerance)) return null
  return { centerX, pitchX: fitPitch, w: row.w, h: row.h }
}

/**
 * 白色块不能靠颜色连通域找到，需要真实边框证据。每条边都在小范围内
 * 找连续线段，圆角的两端不计入；仅有几个文字笔画不会满足覆盖率。
 */
function edgeCoverage(
  img: ImageData, bg: RGB, vertical: boolean, coordinate: number, start: number, length: number, radius: number,
): number {
  const from = Math.ceil(start + length * 0.2), to = Math.floor(start + length * 0.8)
  if (to <= from) return 0
  let best = 0
  for (let edge = Math.round(coordinate - radius); edge <= Math.round(coordinate + radius); edge++) {
    if (edge < 1 || edge >= (vertical ? img.width : img.height) - 1) continue
    let support = 0, total = 0
    for (let p = from; p <= to; p += Math.max(1, Math.floor(length / 50))) {
      const x = vertical ? edge : p, y = vertical ? p : edge
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue
      const index = (y * img.width + x) * 4
      const rgb: RGB = [img.data[index], img.data[index + 1], img.data[index + 2]]
      if (colorDistance(rgb, bg) >= 16) support++
      total++
    }
    if (total) best = Math.max(best, support / total)
  }
  return best
}

function swatchEvidence(
  img: ImageData, bg: RGB, rect: { x: number; y: number; w: number; h: number }, step: number,
): number {
  const rx = Math.max(step * 2, rect.w * 0.06), ry = Math.max(step * 2, rect.h * 0.12)
  if (rect.x - rx < 0 || rect.x + rect.w + rx >= img.width || rect.y - ry < 0 || rect.y + rect.h + ry >= img.height) return 0
  const left = edgeCoverage(img, bg, true, rect.x, rect.y, rect.h, rx)
  const right = edgeCoverage(img, bg, true, rect.x + rect.w, rect.y, rect.h, rx)
  const top = edgeCoverage(img, bg, false, rect.y, rect.x, rect.w, ry)
  let bottom = edgeCoverage(img, bg, false, rect.y + rect.h, rect.x, rect.w, ry)
  // 横长色块常与下方数量共用外框：白色块的中间没有分隔线。
  if (rect.w / rect.h > 1.8 && rect.y + rect.h * 2 + ry < img.height) {
    bottom = Math.max(bottom, edgeCoverage(img, bg, false, rect.y + rect.h * 2, rect.x, rect.w, ry))
  }
  return Math.min(left, right, top, bottom)
}

function clippedSwatchEvidence(
  img: ImageData, bg: RGB, rect: { x: number; y: number; w: number; h: number }, step: number,
): boolean {
  const rx = Math.max(step * 2, rect.w * 0.06), ry = Math.max(step * 2, rect.h * 0.12)
  if (rect.x >= rx && rect.x + rect.w + rx < img.width && rect.y + rect.h + ry < img.height) return false
  const sides = [
    edgeCoverage(img, bg, true, rect.x, rect.y, rect.h, rx),
    edgeCoverage(img, bg, true, rect.x + rect.w, rect.y, rect.h, rx),
    edgeCoverage(img, bg, false, rect.y, rect.x, rect.w, ry),
    edgeCoverage(img, bg, false, rect.y + rect.h, rect.x, rect.w, ry),
  ]
  return sides.filter((coverage) => coverage >= 0.65).length >= 2
}

/**
 * 把一排的周期位置逐个核实。遇到无边框的内部位置、被截断的末块，
 * 或排尾之后仍有未纳入的填色块，整张图例都不能作为封闭色板使用。
 */
function reconstructRows(img: ImageData, bg: RGB, rows: LegendRow[], step: number, beforeLegendY: number): ChartLegendGeometry | null {
  const primary = [...rows].sort((a, b) => b.members.length - a.members.length)[0]
  if (!primary) return null
  const model = fitRow(primary, step)
  if (!model) return null
  const layout = model.pitchX > model.w * 1.8 ? 'right' : 'below'
  const matching = rows.filter((row) => Math.abs(row.w - model.w) <= model.w * 0.2 && Math.abs(row.h - model.h) <= model.h * 0.2)
    .sort((a, b) => a.y - b.y)
  if (!matching.length || matching.length !== rows.length) return null
  const swatches: ChartLegendSwatch[] = []
  let weakest = 1
  let firstColumn = 0
  let firstRowLength = 0
  for (const [rowIndex, row] of matching.entries()) {
    const tolerance = Math.max(step * 3, model.w * 0.1)
    const columns = row.members.map((c) => {
      const center = c.x + c.w / 2
      const col = Math.round((center - model.centerX) / model.pitchX)
      return Math.abs(center - model.centerX - col * model.pitchX) <= tolerance ? col : null
    })
    if (columns.some((col) => col === null)) return null
    const knownColumns = columns as number[]
    const min = Math.min(...knownColumns), max = Math.max(...knownColumns)
    const rectangle = (col: number) => ({
      x: Math.round(model.centerX + col * model.pitchX - model.w / 2),
      y: Math.round(row.y), w: Math.round(model.w), h: Math.round(model.h),
    })
    let first = min, last = max
    // 恢复排首/排尾的白块；只有查到完整边框才延伸。
    for (let col = min - 1; col >= min - 4; col--) {
      if (swatchEvidence(img, bg, rectangle(col), step) < 0.65) break
      first = col
    }
    for (let col = max + 1; col <= max + 8; col++) {
      if (swatchEvidence(img, bg, rectangle(col), step) < 0.65) break
      last = col
    }
    // 连续白块超过恢复预算时也要拒绝，不能静默截断为较小色板。
    if (swatchEvidence(img, bg, rectangle(first - 1), step) >= 0.65
      || swatchEvidence(img, bg, rectangle(last + 1), step) >= 0.65) return null
    if (clippedSwatchEvidence(img, bg, rectangle(first - 1), step)
      || clippedSwatchEvidence(img, bg, rectangle(last + 1), step)) return null
    // 各排应从同一列开始，短末排只允许在右侧结束。
    if (!rowIndex) {
      firstColumn = first
      firstRowLength = last - first + 1
    } else if (first !== firstColumn || last - first + 1 > firstRowLength) return null
    for (let col = first; col <= last; col++) {
      const rect = rectangle(col)
      const evidence = swatchEvidence(img, bg, rect, step)
      if (evidence < 0.65) return null
      weakest = Math.min(weakest, evidence)
      swatches.push({ ...rect, rgb: rectangleColor(img, rect) })
    }
    const finalRect = rectangle(last)
    // 给排尾留出外框和数量标签所需空间，边界上被裁切的图例不可限制色板。
    const rightRoom = layout === 'right' ? model.pitchX - model.w : Math.max(step * 3, model.w * 0.08)
    const bottomRoom = layout === 'below' ? model.h * (model.w / model.h > 1.8 ? 0.9 : 0.35) : step * 3
    if (finalRect.x + finalRect.w + rightRoom >= img.width || finalRect.y + finalRect.h + bottomRoom >= img.height) return null
  }
  if (swatches.length < 4) return null
  if (matching.length > 1) {
    const gaps = matching.slice(1).map((row, i) => row.y - matching[i].y)
    const pitchY = median(gaps)
    if (pitchY < model.h * 1.1 || pitchY > model.h * 4
      || gaps.some((gap) => Math.abs(gap - pitchY) > Math.max(step * 3, model.h * 0.15))) return null
  }
  // 一整排白块可能没有任何填色候选，不能只检查已检测到的排。搜索
  // 首排之前、各排之间及排尾后的空带，遗漏有边框的白排时拒绝限制。
  for (let i = -1; i < matching.length; i++) {
    const from = i < 0 ? beforeLegendY
      : matching[i].y + model.h * (layout === 'below' && model.w / model.h > 1.8 ? 2.1 : 1.1)
    const to = Math.min(img.height - model.h - step * 2,
      matching[i + 1] ? matching[i + 1].y - model.h * 0.6 : img.height)
    for (let y = Math.ceil(from); y <= to; y += Math.max(2, step * 2)) {
      for (let col = firstColumn; col < firstColumn + firstRowLength; col++) {
        const rect = {
          x: Math.round(model.centerX + col * model.pitchX - model.w / 2),
          y, w: Math.round(model.w), h: Math.round(model.h),
        }
        // 首排之前还有彩色坐标栏。其底色与页面背景相差很大，不是
        // 连通域遗漏的白/近白图例行，不能因为整条坐标栏而误判不完整。
        if (i < 0 && colorDistance(rectangleColor(img, rect), bg) > 20) continue
        if (swatchEvidence(img, bg, rect, step) >= 0.65) return null
      }
    }
  }
  return { swatches, layout, confidence: Math.min(0.98, 0.86 + weakest * 0.12) }
}

/**
 * 只搜索主网格下方。先寻找平坦填色连通域，再验证其行列排列；图例有
 * 重复尺寸和固定间距，不能把零散水印或坐标栏当作色号候选。
 */
export function detectChartLegend(img: ImageData, grid: GridSpec): ChartLegendGeometry | null {
  const pitch = Math.min(grid.cellW, grid.cellH)
  const fromY = Math.max(0, Math.ceil(grid.offsetY + grid.rows * grid.cellH + pitch * 0.08))
  if (pitch < 4 || img.height - fromY < pitch * 0.5) return null
  const step = Math.max(1, Math.floor(pitch / 12))
  const w = Math.ceil(img.width / step)
  const h = Math.ceil((img.height - fromY) / step)
  const pixels = new Uint8Array(w * h * 3)
  const buckets = new Map<number, { n: number; sum: RGB }>()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = ((fromY + y * step) * img.width + x * step) * 4
      const q = (y * w + x) * 3
      const rgb: RGB = [img.data[p], img.data[p + 1], img.data[p + 2]]
      pixels.set(rgb, q)
      const key = ((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4)
      const bucket = buckets.get(key) ?? { n: 0, sum: [0, 0, 0] as RGB }
      bucket.n++
      for (let c = 0; c < 3; c++) bucket.sum[c] += rgb[c]
      buckets.set(key, bucket)
    }
  }
  let backgroundBucket = { n: 0, sum: [0, 0, 0] as RGB }
  for (const bucket of buckets.values()) if (bucket.n > backgroundBucket.n) backgroundBucket = bucket
  const bg = backgroundBucket.sum.map((v) => v / Math.max(1, backgroundBucket.n)) as RGB
  const active = new Uint8Array(w * h)
  for (let i = 0; i < active.length; i++) {
    if (colorDistance([pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]], bg) >= 12) active[i] = 1
  }
  const stack = new Int32Array(w * h)
  const candidates: Component[] = []
  for (let i = 0; i < active.length; i++) {
    if (!active[i]) continue
    const seed: RGB = [pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]]
    let n = 1
    stack[0] = i
    active[i] = 0
    let minX = w, maxX = 0, minY = h, maxY = 0, area = 0
    while (n) {
      const p = stack[--n]
      const x = p % w, y = Math.floor(p / w)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      area++
      const neighbours = [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1]
      for (const next of neighbours) {
        if (next < 0 || !active[next]) continue
        const q = next * 3
        if (colorDistance(seed, [pixels[q], pixels[q + 1], pixels[q + 2]]) > 20) continue
        active[next] = 0
        stack[n++] = next
      }
    }
    const bw = (maxX - minX + 1) * step
    const bh = (maxY - minY + 1) * step
    if (bw < pitch * 0.7 || bh < pitch * 0.45 || bw > pitch * 8 || bh > pitch * 5 || area / ((maxX - minX + 1) * (maxY - minY + 1)) < 0.45) continue
    if (bw / bh < 0.55 || bw / bh > 4.5) continue
    const rect = { x: minX * step, y: fromY + minY * step, w: bw, h: bh }
    candidates.push({ ...rect, area, rgb: rectangleColor(img, rect) })
  }
  // 只有跨越主网格全宽的栏底线确实存在时，才排除一格高度的坐标栏。
  // 没有坐标栏的图纸也可能紧接网格排放白色图例，不能默认跳过它。
  const rulerFloor = grid.offsetY + (grid.rows + 1) * grid.cellH
  const rulerEvidence = edgeCoverage(img, bg, false, rulerFloor, grid.offsetX,
    grid.cols * grid.cellW, Math.max(step * 2, grid.cellH * 0.08))
  const beforeLegendY = rulerEvidence >= 0.85 ? Math.ceil(rulerFloor) : fromY
  return reconstructRows(img, bg, groupRows(candidates, step), step, beforeLegendY)
}
