import { EMPTY, type GridSpec, type Pattern, type Plan, type RGB } from '../types'
import {
  PALETTE,
  deltaE2000,
  nearestAmong,
  nearestAmongWithDistance,
  nearestPaletteIndex,
  rgbToLab,
} from './color'
import { estimatePageBackground } from './gridDetect'
import { sampleCells } from './sample'

/** 用 FNV-1a 对图像内容做指纹，用于关联本地进度（重新标定网格不会丢进度） */
export function hashImage(img: ImageData, extra = ''): string {
  let h = 0x811c9dc5
  const mix = (v: number) => {
    h ^= v & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const { width: W, height: H, data } = img
  mix(W)
  mix(W >>> 8)
  mix(H)
  mix(H >>> 8)
  const stepX = Math.max(1, Math.floor(W / 64))
  const stepY = Math.max(1, Math.floor(H / 64))
  for (let y = 0; y < H; y += stepY) {
    for (let x = 0; x < W; x += stepX) {
      const p = (y * W + x) * 4
      mix(data[p])
      mix(data[p + 1])
      mix(data[p + 2])
    }
  }
  for (let i = 0; i < extra.length; i++) mix(extra.charCodeAt(i))
  return h.toString(16).padStart(8, '0')
}

export interface BuildPatternOptions {
  name: string
  imageUrl: string
  imageHash: string
  /** 页面/纸面背景色，缺省时自动估计 */
  pageBg?: RGB
  /** 是否把「与页面背景同色、且从图纸边界连通」的格子判为空格 */
  dropBackground: boolean
  /** 背景判定色差阈值（CIEDE2000） */
  bgTolerance?: number
  /**
   * 按图纸图例把色板收窄到这些调色板下标。
   * 图纸底部的色号表列出了真正用到的颜色，收窄匹配范围能显著减少
   * 「认成相邻色号」的噪声（实测某实拍图纸 38 色的图纸会认成 116 色）。
   * 若某格在候选集里的最近色差 > unmatchedTolerance，就回退到全色板。
   */
  allowed?: readonly number[] | null
  unmatchedTolerance?: number
}

export interface BuildPatternResult {
  pattern: Pattern
  pageBg: RGB
  /** 被判为空格（背景）的格子数 */
  backgroundCells: number
  /** 因超出容差而回退到全色板的格子数（说明图例可能不全或读错了） */
  unmatched: number
}

export function buildPattern(
  img: ImageData,
  grid: GridSpec,
  opts: BuildPatternOptions,
): BuildPatternResult {
  const n = Math.max(0, grid.cols) * Math.max(0, grid.rows)
  const { rgb, purity } = sampleCells(img, grid)
  const pageBg = opts.pageBg ?? estimatePageBackground(img, grid)
  const bgLab = rgbToLab(pageBg)
  const tol = opts.bgTolerance ?? 9
  const allowed = opts.allowed && opts.allowed.length > 0 ? [...opts.allowed] : null
  const unmatchedTol = opts.unmatchedTolerance ?? 14

  const cells = new Int16Array(n)
  const blank = new Uint8Array(n)
  const bgLike = new Uint8Array(n)
  // 受约束匹配要对大量格子重复求色差，按量化键缓存
  const constrainedCache = new Map<number, number>()
  let unmatched = 0

  for (let i = 0; i < n; i++) {
    if (purity[i] <= 0) {
      cells[i] = EMPTY
      continue
    }
    const c: RGB = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]
    if (allowed) {
      const key = ((c[0] >> 2) << 12) | ((c[1] >> 2) << 6) | (c[2] >> 2)
      let use = constrainedCache.get(key)
      if (use === undefined) {
        const near = nearestAmongWithDistance(c, allowed)
        use = near.index
        if (!Number.isFinite(near.delta) || near.delta > unmatchedTol || use >= PALETTE.length) {
          use = nearestPaletteIndex(c)
          unmatched++
        }
        constrainedCache.set(key, use)
      }
      cells[i] = use
    } else {
      cells[i] = nearestPaletteIndex(c)
    }
    if (opts.dropBackground && deltaE2000(rgbToLab(c), bgLab) <= tol) {
      bgLike[i] = 1
    }
  }

  let backgroundCells = 0
  if (opts.dropBackground) {
    const outside = floodFromBorder(bgLike, grid.cols, grid.rows)
    for (let i = 0; i < n; i++) {
      if (outside[i]) {
        blank[i] = 1
        backgroundCells++
      }
    }
  }

  const pattern: Pattern = {
    id: opts.imageHash,
    name: opts.name,
    imageW: img.width,
    imageH: img.height,
    grid: { ...grid },
    cells,
    blank,
    purity,
    pageBg,
    imageUrl: opts.imageUrl,
    createdAt: Date.now(),
  }

  return { pattern, pageBg, backgroundCells, unmatched }
}

/**
 * 从边界出发对「背景色相似」的格子做洪水填充。
 * 只有与图纸外沿连通的背景色区域才算空格 —— 被图案包住的
 * 白色区域仍然是有意为之的白色豆子。
 */
function floodFromBorder(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(mask.length)
  const stack: number[] = []

  const visit = (i: number) => {
    if (i < 0 || i >= mask.length) return
    if (!mask[i] || out[i]) return
    out[i] = 1
    stack.push(i)
  }

  for (let c = 0; c < cols; c++) {
    visit(c)
    visit((rows - 1) * cols + c)
  }
  for (let r = 0; r < rows; r++) {
    visit(r * cols)
    visit(r * cols + cols - 1)
  }

  while (stack.length > 0) {
    const i = stack.pop() as number
    const r = Math.floor(i / cols)
    const c = i - r * cols
    if (r > 0) visit(i - cols)
    if (r < rows - 1) visit(i + cols)
    if (c > 0) visit(i - 1)
    if (c < cols - 1) visit(i + 1)
  }

  return out
}

/** 原始图纸中每种颜色出现的次数（未排除任何颜色，已剔除空白格） */
export function rawCounts(pattern: Pattern): Map<number, number> {
  const counts = new Map<number, number>()
  for (let i = 0; i < pattern.cells.length; i++) {
    if (pattern.blank[i]) continue
    const v = pattern.cells[i]
    if (v === EMPTY) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return counts
}

/** 空白格数量 */
export function blankCount(pattern: Pattern): number {
  let n = 0
  for (let i = 0; i < pattern.blank.length; i++) if (pattern.blank[i]) n++
  return n
}

export interface PlanOptions {
  /** 把自动识别的空白格当作「不拼」；关掉后这些格子按识别出的颜色算作豆子 */
  treatBlankAsEmpty: boolean
}

/**
 * 应用「排除色」和「空白格策略」得到实际拼装方案。
 * 被排除的颜色会重映射到剩余颜色中最接近的一个（沿用参考项目的做法）。
 */
export function derivePlan(
  pattern: Pattern,
  excluded: ReadonlySet<number>,
  options: PlanOptions = { treatBlankAsEmpty: true },
): Plan {
  const raw = rawCounts(pattern)
  const present = [...raw.keys()]
  let available = present.filter((i) => !excluded.has(i))
  // 不允许把颜色排除到一个不剩
  if (available.length === 0) available = present

  const availableSet = new Set(available)
  const cells = new Int16Array(pattern.cells.length)
  const counts = new Map<number, number>()
  let remapped = 0
  let total = 0

  for (let i = 0; i < pattern.cells.length; i++) {
    const v = pattern.cells[i]
    if (v === EMPTY || (options.treatBlankAsEmpty && pattern.blank[i])) {
      cells[i] = EMPTY
      continue
    }
    let use = v
    if (!availableSet.has(v)) {
      use = nearestAmong(PALETTE[v].rgb, available)
      remapped++
    }
    cells[i] = use
    counts.set(use, (counts.get(use) ?? 0) + 1)
    total++
  }

  const colors = [...counts.keys()].sort((a, b) => {
    const d = (counts.get(b) ?? 0) - (counts.get(a) ?? 0)
    return d !== 0 ? d : PALETTE[a].keys.MARD.localeCompare(PALETTE[b].keys.MARD, 'en', { numeric: true })
  })

  return { cells, counts, colors, total, remapped }
}

/** 低置信度格子（采样纯度偏低，可能是网格没对准） */
export function lowConfidenceCells(pattern: Pattern, threshold = 0.55): number[] {
  const out: number[] = []
  for (let i = 0; i < pattern.purity.length; i++) {
    if (pattern.blank[i]) continue
    if (pattern.cells[i] !== EMPTY && pattern.purity[i] < threshold) out.push(i)
  }
  return out
}
