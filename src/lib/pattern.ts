import { EMPTY, type ChartRecognition, type GridSpec, type Pattern, type Plan, type RGB } from '../types'
import {
  PALETTE,
  colorCacheKey,
  deltaE2000,
  nearestAmong,
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
   */
  allowed?: readonly number[] | null
  /** 超出容差的格子数只用于提示，阈值本身不影响结果 */
  unmatchedTolerance?: number
  /**
   * 是否允许出现「图例之外」的颜色。
   *
   * 默认 false。原因：给了图例就代表「这张图纸只用这些颜色」，
   * 而回退到全色板会**凭空造出图纸上没有的色号** ——
   * 实测用户反馈「识别出了原图没有的 P1、R8」就是这么来的
   * （R08 在色板里没有 ΔE<3 的近色，所以它不是近色翻转，只能是这条回退路径）。
   * 打开这个开关只在「图例确实抄漏了几个色号」时才有意义。
   */
  allowForeignColors?: boolean
  /** 默认逐格匹配。显式 false 可启用旧的近色区域合并，仅供对比诊断。 */
  disableRegionConsistency?: boolean
  /** 图纸上印的色号是权威依据，可靠读到时覆盖填色近似匹配。 */
  textRecognition?: ChartRecognition
}

export interface BuildPatternResult {
  pattern: Pattern
  pageBg: RGB
  /** 被判为空格（背景）的格子数 */
  backgroundCells: number
  /** 最近图例色差仍超出容差的格子数（图例可能不全或读错，但结果仍取最近的图例色） */
  unmatched: number
  /** 回退到了图例之外颜色的格子数（仅在 allowForeignColors 打开时可能非 0） */
  foreign: number
  /** 合并掉的同色区块数（区域一致性生效的证据） */
  mergedRegions: number
}

/**
 * 相邻格颜色接近到这个程度（LAB 欧氏距离 ΔE76）就认为属于同一片。
 *
 * 阈值是量出来的，不是拍脑袋定的（`node tools/palette-audit.mjs` 会扫一遍）：
 *
 *   ΔE76 ≤ 2 →  12 对颜色   （ΔE2000 0.4~2.0）
 *   ΔE76 ≤ 3 →  23 对       （ΔE2000 0.4~2.9）  ← 取这里
 *   ΔE76 ≤ 6 → 106 对       （ΔE2000 0.4~6.5）
 *
 * 取 3 的理由：它正好覆盖「肉眼和 JPEG 噪声都分不开」的那批
 * （实测用户报的 P01 #FCF7F8 ↔ H01 #FDFBFF 是 ΔE76 2.22，落在里面），
 * 而 ΔE76 6 会连 ΔE2000 到 6.5 的**明显不同**的颜色也并掉 ——
 * 那就不是去噪而是真错误了（同一阈值下波及对数从 23 涨到 106）。
 */
const CLUSTER_DE76 = 3

/**
 * 把「相邻且颜色接近」的格子并成连通块，返回每格所属块号 + 每块的代表色。
 *
 * 为什么需要：逐格采样必然带噪声（格内色号文字的笔画、格线、JPEG 压缩），
 * 而调色板里有 **34 对颜色彼此 ΔE < 2.5**（实测 P01 #FCF7F8 与 H01 #FDFBFF 只差 1.95），
 * 噪声一抖格子就换个色号 —— 表现就是「同一片本该同色的区域花掉」，
 * 以及「识别出图纸上根本没有的颜色」。
 *
 * 用 LAB 欧氏距离（ΔE76）而不是 ΔE2000：聚类只需判断「够不够近」，
 * ΔE76 快一个数量级，十几万次相邻比较时差别很明显。
 *
 * 代表色取「离块均值最近的那个格子的颜色」（medoid）而不是直接平均：
 * 格内文字会把平均值拉偏，而 medoid 一定落在真实采样色上。
 */
function clusterByColor(
  rgb: Uint8ClampedArray,
  purity: Float32Array,
  cols: number,
  rows: number,
): { comp: Int32Array; groups: number[][]; repRgb: RGB[] } {
  const n = cols * rows
  const lab = new Float64Array(n * 3)
  const valid = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (purity[i] <= 0) continue
    valid[i] = 1
    const [L, a, b] = rgbToLab([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]])
    lab[i * 3] = L
    lab[i * 3 + 1] = a
    lab[i * 3 + 2] = b
  }

  const thr2 = CLUSTER_DE76 * CLUSTER_DE76
  const comp = new Int32Array(n).fill(-1)
  const groups: number[][] = []
  const repRgb: RGB[] = []
  const stack: number[] = []

  const close = (i: number, j: number): boolean => {
    const dl = lab[i * 3] - lab[j * 3]
    const da = lab[i * 3 + 1] - lab[j * 3 + 1]
    const db = lab[i * 3 + 2] - lab[j * 3 + 2]
    return dl * dl + da * da + db * db <= thr2
  }

  for (let seed = 0; seed < n; seed++) {
    if (!valid[seed] || comp[seed] >= 0) continue
    const id = groups.length
    const members: number[] = []
    stack.length = 0
    stack.push(seed)
    comp[seed] = id
    while (stack.length > 0) {
      const i = stack.pop() as number
      members.push(i)
      const r = (i / cols) | 0
      const c = i - r * cols
      if (c > 0) {
        const j = i - 1
        if (valid[j] && comp[j] < 0 && close(i, j)) {
          comp[j] = id
          stack.push(j)
        }
      }
      if (c < cols - 1) {
        const j = i + 1
        if (valid[j] && comp[j] < 0 && close(i, j)) {
          comp[j] = id
          stack.push(j)
        }
      }
      if (r > 0) {
        const j = i - cols
        if (valid[j] && comp[j] < 0 && close(i, j)) {
          comp[j] = id
          stack.push(j)
        }
      }
      if (r < rows - 1) {
        const j = i + cols
        if (valid[j] && comp[j] < 0 && close(i, j)) {
          comp[j] = id
          stack.push(j)
        }
      }
    }
    groups.push(members)

    // medoid：离块均值最近的那个格子
    let mL = 0
    let mA = 0
    let mB = 0
    for (const i of members) {
      mL += lab[i * 3]
      mA += lab[i * 3 + 1]
      mB += lab[i * 3 + 2]
    }
    mL /= members.length
    mA /= members.length
    mB /= members.length
    let best = members[0]
    let bestD = Infinity
    for (const i of members) {
      const dl = lab[i * 3] - mL
      const da = lab[i * 3 + 1] - mA
      const db = lab[i * 3 + 2] - mB
      const d = dl * dl + da * da + db * db
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    repRgb.push([rgb[best * 3], rgb[best * 3 + 1], rgb[best * 3 + 2]])
  }

  return { comp, groups, repRgb }
}

/** 一个颜色在候选色号上的排名：前两名 + 各自的色差 */
interface Rank {
  first: number
  firstD: number
  second: number
  secondD: number
  /** 是否用了「图例之外的颜色」（只有显式打开该开关时才可能为 true） */
  foreignUsed: boolean
}

/** 在给定候选集里排前两名 */
function rankAmong(c: RGB, candidates: readonly number[]): Rank {
  const lab = rgbToLab(c)
  let b1 = -1
  let d1 = Infinity
  let b2 = -1
  let d2 = Infinity
  for (const i of candidates) {
    const d = deltaE2000(lab, PALETTE[i].lab)
    if (d < d1) {
      b2 = b1
      d2 = d1
      b1 = i
      d1 = d
    } else if (d < d2) {
      b2 = i
      d2 = d
    }
  }
  return { first: b1, firstD: d1, second: b2, secondD: d2, foreignUsed: false }
}

/** 在全色板里排前两名 */
function rankAllPalette(c: RGB): Rank {
  const lab = rgbToLab(c)
  let b1 = -1
  let d1 = Infinity
  let b2 = -1
  let d2 = Infinity
  for (let i = 0; i < PALETTE.length; i++) {
    const d = deltaE2000(lab, PALETTE[i].lab)
    if (d < d1) {
      b2 = b1
      d2 = d1
      b1 = i
      d1 = d
    } else if (d < d2) {
      b2 = i
      d2 = d
    }
  }
  return { first: b1, firstD: d1, second: b2, secondD: d2, foreignUsed: false }
}

/* ------------------------------------------------------------------ */
/* 每格的问题标记                                                       */
/* ------------------------------------------------------------------ */

/** 采样纯度偏低：主色占比小，可能压在网格线上、或有反锯齿/水印 */
export const CELL_LOW_PURITY = 1
/** 色号歧义：第一、第二候选的色差差距很小，颜色上分不出来 */
export const CELL_CLOSE_COLORS = 2
/** 背景候选：颜色接近页面底色且与外沿连通，可能其实是白色豆子 */
export const CELL_BACKGROUND = 4
/** 有印字但没有可靠解码，颜色候选需要人工确认。 */
export const CELL_TEXT_UNCERTAIN = 8
/** 读到的色号与用户限定的色号体系/图例矛盾。 */
export const CELL_TEXT_CONFLICT = 16
export const TEXT_CONFIDENCE_THRESHOLD = 0.85

/** 纯度低于此值算「低纯度」 */
export const LOW_PURITY_THRESHOLD = 0.55
/**
 * margin 低于此值算「色号歧义」。
 *
 * margin = 第二候选色差 − 第一候选色差（CIEDE2000）。
 * 2.0 是保守起点：实测用户图纸里 D17/C27、D20/D7 这种串位都落在很小的 margin 上，
 * 但**这个阈值应该用真实失败图纸校准**，目前只是让歧义格子浮出来给人看。
 */
export const CLOSE_COLORS_MARGIN = 2

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
  const second = new Int16Array(n).fill(-1)
  const margin = new Float32Array(n)
  // 一个颜色只需要算一次排名，按完整颜色缓存（见 colorCacheKey 的说明）
  const rankCache = new Map<number, Rank>()
  let unmatched = 0
  let foreign = 0

  for (let i = 0; i < n; i++) {
    if (purity[i] <= 0) cells[i] = EMPTY
  }

  /**
   * 把一个颜色排到候选色号上，返回前两名与它们的色差。
   *
   * 为什么必须留第二名：`purity` 只说明采样区域颜色是否一致，
   * 而**高纯度不代表色号对** —— 一个格子可以非常纯，却同时贴近两个色号
   * （实测用户图纸里 D17 被认成 C27、D20 被认成 D7 都属于这种）。
   * 真正该看的是第一候选比第二候选好多少，也就是 secondD - firstD。
   */
  const rankColor = (c: RGB): Rank => {
    const key = colorCacheKey(c)
    const hit = rankCache.get(key)
    if (hit) return hit
    let r: Rank
    if (!allowed) {
      r = rankAllPalette(c)
    } else {
      r = rankAmong(c, allowed)
      if (!Number.isFinite(r.firstD) || r.first >= PALETTE.length) {
        const g = rankAllPalette(c)
        r = { ...r, first: g.first, firstD: g.firstD }
      }
      if (r.firstD > unmatchedTol && opts.allowForeignColors) {
        // 只有显式打开「允许图例之外的颜色」才回退到全色板；
        // 默认严格只用图例 —— 硬塞一个图例外的色号就等于凭空造色号
        const g = rankAllPalette(c)
        r = { first: g.first, firstD: g.firstD, second: r.first, secondD: r.firstD, foreignUsed: true }
      }
    }
    rankCache.set(key, r)
    return r
  }

  /**
   * 把一个颜色映射到色号。
   * allowed 存在时只在这个集合里挑 —— 除非显式打开 allowForeignColors。
   *
   * 缓存键用 colorCacheKey（完整 24 位），不能量化分桶：
   * 原来按 6 位/通道分桶时桶内所有颜色共用首次算出的答案，而实测色板里有
   * 3 对颜色正好同桶（G15 #FCF9E0 / H21 #FFFBE1、H2 #FEFFFF / T1 #FFFFFF、Q4 / R11），
   * 于是同一种输入、处理顺序不同就得到不同色号 —— 可复现性问题。
   */
  let mergedRegions = 0
  // 默认逐格保留真实近色边界；传递连通合并会吞掉不同色号。
  if (opts.disableRegionConsistency !== false) {
    for (let i = 0; i < n; i++) {
      if (purity[i] <= 0) continue
      const c: RGB = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]
      const r = rankColor(c)
      cells[i] = r.first
      second[i] = r.second
      margin[i] = r.secondD - r.firstD
      if (allowed && r.firstD > unmatchedTol) unmatched++
      if (r.foreignUsed) foreign++
    }
  } else {
    // 先按颜色并成块，再整块用一个色号 —— 区域内部的随机翻转就消失了
    const { groups, repRgb } = clusterByColor(rgb, purity, grid.cols, grid.rows)
    for (let k = 0; k < groups.length; k++) {
      const r = rankColor(repRgb[k])
      const size = groups[k].length
      // 越界计数按**格子**累计（用户看到的是「有多少格」），
      // 但排名本身按颜色算一次就够了。
      if (allowed && r.firstD > unmatchedTol) unmatched += size
      if (r.foreignUsed) foreign += size
      for (const i of groups[k]) {
        cells[i] = r.first
        // 整块共用一个色号，所以候选与 margin 也整块共享 —— 这符合语义：
        // 决定是**按块**做的，不是按格。
        second[i] = r.second
        margin[i] = r.secondD - r.firstD
      }
    }
    mergedRegions = groups.length
  }

  const text = opts.textRecognition
  const validText = text && text.indices.length === n && text.confidence.length === n && text.hasText.length === n
    ? text : undefined
  const acceptedText = new Uint8Array(n)
  const textFlags = new Uint8Array(n)
  const allowedSet = allowed ? new Set(allowed) : null
  let recognizedCells = 0
  let unresolvedCells = 0
  if (validText) {
    for (let i = 0; i < n; i++) {
      const index = validText.indices[i]
      const confidence = validText.confidence[i]
      const reliable = index >= 0 && index < PALETTE.length && Number.isFinite(confidence) && confidence >= TEXT_CONFIDENCE_THRESHOLD
      const permitted = !allowedSet || allowedSet.has(index) || opts.allowForeignColors
      if (reliable && permitted && purity[i] > 0) {
        const colorRank = rankColor([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]])
        if (allowed && colorRank.firstD > unmatchedTol) unmatched--
        if (colorRank.foreignUsed) foreign--
        if (cells[i] !== index) second[i] = cells[i]
        cells[i] = index
        acceptedText[i] = 1
        recognizedCells++
      } else if (validText.hasText[i]) {
        textFlags[i] = CELL_TEXT_UNCERTAIN
        if (reliable && !permitted) textFlags[i] |= CELL_TEXT_CONFLICT
        unresolvedCells++
      }
    }
  }

  if (opts.dropBackground) {
    for (let i = 0; i < n; i++) {
      if (purity[i] <= 0 || acceptedText[i] || validText?.hasText[i]) continue
      const c: RGB = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]
      if (deltaE2000(rgbToLab(c), bgLab) <= tol) bgLike[i] = 1
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

  // 每格的问题标记：让「哪里需要人工核对」有明确理由，而不是只给一个分数
  const flags = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (cells[i] === EMPTY) continue
    let f = textFlags[i]
    if (!acceptedText[i] && purity[i] < LOW_PURITY_THRESHOLD) f |= CELL_LOW_PURITY
    if (!acceptedText[i] && second[i] >= 0 && margin[i] < CLOSE_COLORS_MARGIN) f |= CELL_CLOSE_COLORS
    if (bgLike[i]) f |= CELL_BACKGROUND
    flags[i] = f
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
    second,
    margin,
    flags,
    textConfidence: validText?.confidence,
    recognition: validText ? { ...validText.summary, recognizedCells, unresolvedCells } : undefined,
    pageBg,
    imageUrl: opts.imageUrl,
    createdAt: Date.now(),
  }

  return { pattern, pageBg, backgroundCells, unmatched, foreign, mergedRegions }
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

/**
 * 需要人工核对的格子。
 *
 * 判据从「采样纯度低」改成「**色号歧义 + 采样纯度低**」，并按严重程度排序：
 *
 * - 原来只看 purity，但**高纯度不代表色号对** —— 一个格子可以颜色非常纯，
 *   却同时贴近两个色号（实测 D17↔C27、D20↔D7 就是这种），purity 完全看不出来。
 * - 现在优先给 margin 最小的格子（第一、第二候选几乎一样近），
 *   因为那才是「可能认错」的直接证据；低纯度的排在后面。
 *
 * 旧项目没有 flags/margin 字段时回退到按 purity 判断。
 */
export function lowConfidenceCells(pattern: Pattern, limit = 400): number[] {
  const cands: { i: number; key: number }[] = []
  const hasEvidence = pattern.margin !== undefined && pattern.flags !== undefined
  for (let i = 0; i < pattern.cells.length; i++) {
    if (pattern.cells[i] === EMPTY || pattern.blank[i]) continue
    if (hasEvidence) {
      const f = pattern.flags![i]
      if ((f & (CELL_CLOSE_COLORS | CELL_LOW_PURITY | CELL_BACKGROUND | CELL_TEXT_UNCERTAIN | CELL_TEXT_CONFLICT)) === 0) continue
      // 歧义格子的排序键 = margin（越小越可疑）；低纯度但无歧义的给一个较大的键
      const isAmbig = (f & CELL_CLOSE_COLORS) !== 0
      const textProblem = (f & (CELL_TEXT_UNCERTAIN | CELL_TEXT_CONFLICT)) !== 0
      cands.push({ i, key: textProblem ? -2 + (pattern.textConfidence?.[i] ?? 0) : isAmbig ? pattern.margin![i] : CLOSE_COLORS_MARGIN + pattern.purity[i] })
    } else if (pattern.purity[i] < LOW_PURITY_THRESHOLD) {
      cands.push({ i, key: pattern.purity[i] })
    }
  }
  cands.sort((a, b) => a.key - b.key)
  return cands.slice(0, limit).map((c) => c.i)
}
