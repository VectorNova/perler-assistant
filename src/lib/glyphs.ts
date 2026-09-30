/**
 * 逐格读图纸上印的色号。
 *
 * 为什么必须走这条路（有实测支撑，不是偏好）：
 * 两张测试图纸都是**无损 PNG、填色精确**，但和任何一套色板都对不上 ——
 *   哥伦比亚图纸：24 个主色里只有 3 个精确命中
 *   奥黛塔图纸  ：40 个主色里只有 2 个精确命中，**中位距离 12.6**
 * 所以「按填色反推色号」只能是近似，D17↔C27 这种相邻色号必然串位。
 * 图纸上印的色号才是权威 —— 能读到就用读到的，读不到再回退颜色。
 *
 * 这一层只负责「把字切出来」，不负责认。认字分两步：
 *   ① 全图字符按形状聚类 → 只有 20~30 种字形（用到的字母和数字）
 *   ② 用颜色先验 + 全局一致性给字形类贴标签
 * 因为同一颜色的格子印的是同一个色号，所以「一种颜色认一个样本」就够了，
 * 不需要逐格都认对 —— 这也让小格子图能靠同色叠加降噪。
 */
import type { GridSpec, RGB } from '../types'
import { rgbToHex } from './color'

/** 文字像素判定：与格子填色的 RGB 欧氏距离超过这个值。
 *  对「深底白字」和「浅底黑字」都成立，不需要分别处理。 */
const TEXT_DIST = 64

/** 内缩比例：避开格子边框与网格线 */
const INSET_RATIO = 0.14

/** 归一化字符的尺寸（所有字符缩放到同一尺寸才能聚类比较） */
export const GLYPH_W = 10
export const GLYPH_H = 14

export interface GlyphChar {
  /** 归一化后的二值位图，1 = 有墨 */
  bits: Uint8Array
  /** 归一化前的原始宽高，用于区分 '.' ',' '1' 这类窄字 */
  rawW: number
  rawH: number
}

export interface CellGlyph {
  /** 格子序号 row * cols + col */
  index: number
  col: number
  row: number
  /** 该格填色（内缩区域的众数） */
  fill: RGB
  /** 文字掩码，尺寸 = bw × bh */
  mask: Uint8Array
  bw: number
  bh: number
  /** 文字外接框（在 mask 局部坐标里）；无文字时为 null */
  box: { x0: number; y0: number; x1: number; y1: number } | null
  /** 切分出的字符，从左到右 */
  chars: GlyphChar[]
  /** 文字像素占比，太低说明这格没有印字 */
  inkRatio: number
}

export interface ExtractResult {
  cells: CellGlyph[]
  cols: number
  rows: number
  /** 有文字的格子数 */
  withText: number
  /** 切出的字符总数 */
  totalChars: number
}

/** 众数色（量化到 5 位再统计，避免抖动） */
function modeOf(data: Uint8ClampedArray, width: number, x0: number, y0: number, w: number, h: number): RGB {
  const hist = new Map<number, number>()
  const acc = new Map<number, [number, number, number]>()
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = (y * width + x) * 4
      const r = data[p]
      const g = data[p + 1]
      const b = data[p + 2]
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      hist.set(key, (hist.get(key) ?? 0) + 1)
      if (!acc.has(key)) acc.set(key, [r, g, b])
    }
  }
  let best = -1
  let bestN = -1
  for (const [k, n] of hist) {
    if (n > bestN) {
      bestN = n
      best = k
    }
  }
  return acc.get(best) ?? [0, 0, 0]
}

/**
 * 把一个字符位图按外接框缩放到 GLYPH_W × GLYPH_H。
 * 用最近邻采样：字形本身就是像素字体，插值只会引入灰边、反而难聚类。
 */
function normalizeChar(
  mask: Uint8Array,
  bw: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): GlyphChar {
  const rawW = x1 - x0 + 1
  const rawH = y1 - y0 + 1
  const bits = new Uint8Array(GLYPH_W * GLYPH_H)
  for (let gy = 0; gy < GLYPH_H; gy++) {
    const sy = y0 + Math.min(rawH - 1, Math.floor(((gy + 0.5) * rawH) / GLYPH_H))
    for (let gx = 0; gx < GLYPH_W; gx++) {
      const sx = x0 + Math.min(rawW - 1, Math.floor(((gx + 0.5) * rawW) / GLYPH_W))
      if (sy >= 0 && sy < mask.length / bw && sx >= 0 && sx < bw) {
        bits[gy * GLYPH_W + gx] = mask[sy * bw + sx]
      }
    }
  }
  return { bits, rawW, rawH }
}

/** 抽取一个格子的字形 */
function extractCell(
  data: Uint8ClampedArray,
  width: number,
  grid: GridSpec,
  col: number,
  row: number,
): CellGlyph {
  const index = row * grid.cols + col
  const cx = grid.offsetX + col * grid.cellW
  const cy = grid.offsetY + row * grid.cellH
  const inset = Math.max(1, Math.round(Math.min(grid.cellW, grid.cellH) * INSET_RATIO))
  const x0 = Math.round(cx) + inset
  const y0 = Math.round(cy) + inset
  const bw = Math.max(1, Math.round(grid.cellW) - inset * 2)
  const bh = Math.max(1, Math.round(grid.cellH) - inset * 2)

  const fill = modeOf(data, width, x0, y0, bw, bh)
  const [fr, fg, fb] = fill

  const mask = new Uint8Array(bw * bh)
  let ink = 0
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const p = ((y0 + y) * width + (x0 + x)) * 4
      const dr = data[p] - fr
      const dg = data[p + 1] - fg
      const db = data[p + 2] - fb
      if (dr * dr + dg * dg + db * db > TEXT_DIST * TEXT_DIST) {
        mask[y * bw + x] = 1
        ink++
      }
    }
  }

  const inkRatio = ink / (bw * bh)
  if (inkRatio < 0.01) {
    return { index, col, row, fill, mask, bw, bh, box: null, chars: [], inkRatio }
  }

  // 文字外接框
  let bx0 = bw
  let by0 = bh
  let bx1 = -1
  let by1 = -1
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (!mask[y * bw + x]) continue
      if (x < bx0) bx0 = x
      if (x > bx1) bx1 = x
      if (y < by0) by0 = y
      if (y > by1) by1 = y
    }
  }

  // 按列投影切字符：有墨的列连成一段，列间断 1 像素以内算同一个字
  const colInk = new Uint8Array(bw)
  for (let x = 0; x < bw; x++) {
    for (let y = by0; y <= by1; y++) {
      if (mask[y * bw + x]) {
        colInk[x] = 1
        break
      }
    }
  }
  const chars: GlyphChar[] = []
  let start = -1
  let gap = 0
  const flush = (end: number) => {
    if (start < 0 || end < start) {
      start = -1
      gap = 0
      return
    }
    chars.push(normalizeChar(mask, bw, start, end, by0, by1))
    start = -1
    gap = 0
  }
  for (let x = 0; x < bw; x++) {
    if (colInk[x]) {
      if (start < 0) start = x
      gap = 0
    } else if (start >= 0) {
      gap++
      if (gap >= 2) flush(x - gap)
    }
  }
  flush(bw - 1)

  return { index, col, row, fill, mask, bw, bh, box: { x0: bx0, y0: by0, x1: bx1, y1: by1 }, chars, inkRatio }
}

export interface ExtractOptions {
  /** 只抽这些格子（用于调试）；不给就全抽 */
  limit?: { col: number; row: number; cols: number; rows: number }
  /** 抽到的格子少于这个文字占比就当作没印字 */
  minInk?: number
}

export function extractGlyphs(img: ImageData, grid: GridSpec, opts: ExtractOptions = {}): ExtractResult {
  const data = img.data
  const width = img.width
  const region = opts.limit ?? { col: 0, row: 0, cols: grid.cols, rows: grid.rows }
  const cells: CellGlyph[] = []
  let withText = 0
  let totalChars = 0
  const minInk = opts.minInk ?? 0.012
  for (let r = 0; r < region.rows; r++) {
    for (let c = 0; c < region.cols; c++) {
      const g = extractCell(data, width, grid, region.col + c, region.row + r)
      if (g.chars.length > 0 && g.inkRatio >= minInk) {
        withText++
        totalChars += g.chars.length
      }
      cells.push(g)
    }
  }
  return { cells, cols: region.cols, rows: region.rows, withText, totalChars }
}

/** 便于调试：把一格的掩码渲染成字符串 */
export function maskToText(g: CellGlyph): string[] {
  if (g.chars.length === 0) return []
  return g.chars.map((ch) => {
    const lines: string[] = []
    for (let y = 0; y < GLYPH_H; y++) {
      let s = ''
      for (let x = 0; x < GLYPH_W; x++) s += ch.bits[y * GLYPH_W + x] ? '#' : '.'
      lines.push(s)
    }
    return lines.join('\n')
  })
}

/** 该格填色的 HEX，便于和色板对照 */
export function fillHex(g: CellGlyph): string {
  return rgbToHex(g.fill)
}
