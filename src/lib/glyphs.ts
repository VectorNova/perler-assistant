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

/**
 * 调试用：把格子的掩码按**原始分辨率**画出来（不缩放）。
 *
 * 为什么要这个：把字缩放到统一的 10×14 再比较，会丢掉小字之间的差别
 * （实测 6 和 8 被压成了同一个形状）。要看清楚到底丢了什么，
 * 就得先看缩放之前的原样像素。
 */
export function rawMaskToText(g: CellGlyph): string[] {
  const out: string[] = []
  for (let y = 0; y < g.bh; y++) {
    let s = ''
    for (let x = 0; x < g.bw; x++) s += g.mask[y * g.bw + x] ? '#' : '.'
    out.push(s)
  }
  return out
}

/** 该格填色的 HEX，便于和色板对照 */
export function fillHex(g: CellGlyph): string {
  return rgbToHex(g.fill)
}

/* ------------------------------------------------------------------ */
/* 第 2 步：字符聚类 + 贴标签                                            */
/* ------------------------------------------------------------------ */

export interface CharRef {
  /** 属于第几格（cells 数组下标） */
  cell: number
  /** 该格内第几个字符（从左到右，0 基） */
  pos: number
}

export interface GlyphClass {
  id: number
  /** 类中心位图（10×14） */
  bits: Uint8Array
  /** 该类出现的次数 */
  count: number
}

export interface ClusterResult {
  classes: GlyphClass[]
  /** 与 refs 一一对应的类号 */
  assign: Int32Array
  refs: CharRef[]
}

/** 两个归一化位图的汉明距离 */
function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

/**
 * 把全图字符按形状聚成若干类。
 *
 * 分两级：先按位图精确分组（像素字体在固定字号下，同一个字往往**逐位相同**，
 * 这一步就能把 22853 个字符压到几十组），再把彼此只差几个像素的组并起来
 * （抗锯齿/亚像素偏移造成的抖动）。两级都做完，类的数量应当等于
 * 「这张图纸实际用到的不同字符数」—— 字母 + 数字，二三十个量级。
 */
export function clusterChars(cells: CellGlyph[], mergeDist = 9): ClusterResult {
  const refs: CharRef[] = []
  const groupIndex = new Map<string, number>()
  const groupBits: Uint8Array[] = []
  const groupCount: number[] = []
  /** 每个字符属于哪个「精确组」 */
  const charGroup: number[] = []

  for (let ci = 0; ci < cells.length; ci++) {
    const cell = cells[ci]
    for (let p = 0; p < cell.chars.length; p++) {
      const bits = cell.chars[p].bits
      let key = ''
      for (let i = 0; i < bits.length; i++) key += bits[i] ? '1' : '0'
      let g = groupIndex.get(key)
      if (g === undefined) {
        g = groupBits.length
        groupIndex.set(key, g)
        groupBits.push(bits)
        groupCount.push(0)
      }
      groupCount[g]++
      refs.push({ cell: ci, pos: p })
      charGroup.push(g)
    }
  }

  // 合并：每个精确组归到某个类中心（差的像素很少就并）
  const centerBits: Uint8Array[] = []
  const centerCount: number[] = []
  const groupToClass = new Int32Array(groupBits.length).fill(-1)
  for (let g = 0; g < groupBits.length; g++) {
    let hit = -1
    for (let k = 0; k < centerBits.length; k++) {
      if (hamming(groupBits[g], centerBits[k]) <= mergeDist) {
        hit = k
        break
      }
    }
    if (hit < 0) {
      centerBits.push(groupBits[g])
      centerCount.push(groupCount[g])
      hit = centerBits.length - 1
    } else {
      centerCount[hit] += groupCount[g]
    }
    groupToClass[g] = hit
  }

  const assign = new Int32Array(refs.length)
  for (let i = 0; i < refs.length; i++) assign[i] = groupToClass[charGroup[i]]

  const classes: GlyphClass[] = centerBits.map((b, i) => ({ id: i, bits: b, count: centerCount[i] }))
  // 按出现次数从多到少排，便于人看
  const order = classes.map((c) => c.id).sort((a, b) => classes[b].count - classes[a].count)
  const toNew = new Int32Array(classes.length)
  order.forEach((old, nw) => (toNew[old] = nw))
  const sorted = order.map((old) => ({ ...classes[old], id: toNew[old] }))
  for (let i = 0; i < assign.length; i++) assign[i] = toNew[assign[i]]

  return { classes: sorted, assign, refs }
}

export interface LabelOptions {
  /** 每格的候选色号（按颜色距离由近到远），与 cells 一一对应 */
  candidates: string[][]
  /** 候选最多看几个（太多会让求解变慢且没意义） */
  maxCandidates?: number
}

export interface LabelResult {
  /** 字形类 → 字符；解不出为 null */
  charOf: (string | null)[]
  /** 每格读出的色号；读不出为 null（调用方回退到颜色匹配） */
  readCode: (string | null)[]
  stats: {
    classes: number
    labeledClasses: number
    cellsTotal: number
    cellsRead: number
    /** 读出的色号与颜色先验首选不一致的格子数（用于发现先验本身有问题） */
    disagreedWithColor: number
    /** 出现了自相矛盾（同一字形类被要求是两个不同字符）的格子数 */
    conflicted: number
  }
}

/**
 * 用「颜色先验 + 全局一致性」给字形类贴标签，并读出每格的色号。
 *
 * 为什么能自动贴上标签：每个格子都有颜色先验（填色 → 最近的几个候选色号），
 * 而候选色号本身是**已知的字符串**。一个格子的字形序列必须和某个候选色号逐字对上 ——
 * 满足这个约束的格子会直接把「第 3 类 = 'D'」这样的信息钉死。
 * 钉死的信息又能解锁更多格子，迭代到不再变化为止。
 *
 * 这正是自监督的关键：**不需要预先知道字体**，字形与字符的对应关系完全从
 * 「颜色说得通 + 全局一致」里长出来。剩下解不出的格子交给颜色兜底。
 */
export function labelGlyphs(
  cells: CellGlyph[],
  cluster: ClusterResult,
  opts: LabelOptions,
): LabelResult {
  const nClasses = cluster.classes.length
  const charOf: (string | null)[] = new Array(nClasses).fill(null)
  const maxCand = opts.maxCandidates ?? 8

  // 每格的候选（截断），并记下字形序列
  const cellCands: string[][] = []
  const cellSeq: number[][] = []
  for (let i = 0; i < cells.length; i++) {
    cellCands.push((opts.candidates[i] ?? []).slice(0, maxCand))
    cellSeq.push(new Array(cells[i].chars.length).fill(-1))
  }
  for (let i = 0; i < cluster.refs.length; i++) {
    const r = cluster.refs[i]
    const seq = cellSeq[r.cell]
    if (r.pos < seq.length) seq[r.pos] = cluster.assign[i]
  }

  /** 该候选色号是否和当前已知的字形映射相容；相容则返回它在序列里的逐字对应 */
  const compatible = (seq: number[], code: string): boolean => {
    if (code.length !== seq.length) return false
    for (let p = 0; p < seq.length; p++) {
      const known = charOf[seq[p]]
      if (known !== null && known !== code[p]) return false
    }
    return true
  }

  const conflicted = new Set<number>()
  for (let round = 0; round < 12; round++) {
    let changed = false
    for (let i = 0; i < cells.length; i++) {
      const seq = cellSeq[i]
      if (seq.length === 0 || seq.some((s) => s < 0)) continue
      const ok = cellCands[i].filter((c) => compatible(seq, c))
      if (ok.length !== 1) continue
      const code = ok[0]
      for (let p = 0; p < seq.length; p++) {
        const cls = seq[p]
        if (charOf[cls] === null) {
          charOf[cls] = code[p]
          changed = true
        } else if (charOf[cls] !== code[p]) {
          conflicted.add(i)
        }
      }
    }
    if (!changed) break
  }

  // 用最终映射去读每一格
  const readCode: (string | null)[] = new Array(cells.length).fill(null)
  let cellsRead = 0
  let disagreed = 0
  for (let i = 0; i < cells.length; i++) {
    const seq = cellSeq[i]
    if (seq.length === 0 || seq.some((s) => s < 0)) continue
    const ok = cellCands[i].filter((c) => compatible(seq, c))
    if (ok.length === 1) {
      readCode[i] = ok[0]
      cellsRead++
      if (cellCands[i][0] && cellCands[i][0] !== ok[0]) disagreed++
    }
  }

  return {
    charOf,
    readCode,
    stats: {
      classes: nClasses,
      labeledClasses: charOf.filter((c) => c !== null).length,
      cellsTotal: cells.length,
      cellsRead,
      disagreedWithColor: disagreed,
      conflicted: conflicted.size,
    },
  }
}

/** 一个字形类渲染成 ASCII，便于人工核对 */
export function classToText(bits: Uint8Array): string[] {
  const lines: string[] = []
  for (let y = 0; y < GLYPH_H; y++) {
    let s = ''
    for (let x = 0; x < GLYPH_W; x++) s += bits[y * GLYPH_W + x] ? '#' : '.'
    lines.push(s)
  }
  return lines
}

/**
 * 用约束搜索（DFS + 剪枝）解出「字形类 → 字符」，并读出每个颜色组的色号。
 *
 * 为什么不能只做单向传播：一开始没有任何标签固定，所有同长度的色号都「相容」，
 * 传播启动不了（实测 0 组解出，每组剩 81~140 个候选）。
 * 必须搜索：给字形类试字符，只要有一个颜色组的候选全被排除就回溯。
 *
 * 约束强度来自规模：66 个颜色组的序列都必须落在词表里。
 * 随机映射下一条 3 字符序列碰巧是合法色号的概率约 221/36³ ≈ 0.5%，
 * 66 组同时满足几乎不可能 —— 所以合法解通常唯一或极少。
 *
 * 颜色先验在这里只当**多个解之间的裁判**（选「读出的色号与填色最近」的那个），
 * 而不是硬约束 —— 因为实测这批图纸的填色和公开色板对不上，先验本身不可靠。
 */
export function solveGroups(
  groups: ColorGroup[],
  nClasses: number,
  opts: SolveOptions,
): GroupLabelResult & { nodes: number; solutions: number } {
  const vocab = opts.vocab
  const maxNodes = opts.maxNodes ?? 400000
  const byLen = new Map<number, string[]>()
  for (const code of vocab) {
    const l = code.length
    const a = byLen.get(l)
    if (a) a.push(code)
    else byLen.set(l, [code])
  }
  // 每个颜色组按其序列长度取候选词
  const cands: string[][] = groups.map((g) => byLen.get(g.seq.length) ?? [])
  const seqs: number[][] = groups.map((g) => g.seq)

  // 哪些组包含某个类、在该组的哪个位置
  const groupsOfClass: number[][] = Array.from({ length: nClasses }, () => [])
  const posOfClass: Map<number, number[]>[] = Array.from({ length: nClasses }, () => new Map())
  groups.forEach((g, gi) => {
    g.seq.forEach((cls, p) => {
      if (cls < 0 || cls >= nClasses) return
      groupsOfClass[cls].push(gi)
      const m = posOfClass[cls]
      const arr = m.get(gi)
      if (arr) arr.push(p)
      else m.set(gi, [p])
    })
  })

  const charOf: (string | null)[] = new Array(nClasses).fill(null)
  // 按「参与的组数」从多到少定序：约束最强的先定
  const order = Array.from({ length: nClasses }, (_, i) => i)
    .filter((i) => groupsOfClass[i].length > 0)
    .sort((a, b) => groupsOfClass[b].length - groupsOfClass[a].length)

  const compatible = (gi: number, code: string): boolean => {
    const seq = seqs[gi]
    if (code.length !== seq.length) return false
    for (let p = 0; p < seq.length; p++) {
      const known = charOf[seq[p]]
      if (known !== null && known !== code[p]) return false
    }
    return true
  }

  const alive = new Uint8Array(groups.length)
  const refreshAll = () => {
    for (let gi = 0; gi < groups.length; gi++) {
      alive[gi] = cands[gi].some((c) => compatible(gi, c)) ? 1 : 0
    }
  }
  refreshAll()

  let nodes = 0
  let solutions = 0
  let bestChar: (string | null)[] | null = null
  let bestScore = Infinity

  /**
   * 目标函数：把每个颜色组解码出的色号，与它**填色**的色差加起来，越小越好。
   *
   * 为什么用「色差之和」而不是「首选是否命中」：
   * 后者只有 0/1 两个取值，几十种候选映射全同分，搜索会取第一个
   * （实测取到过 A1/A10/A11 这种明显错误的退化解）。
   * 色差之和是连续量，正确映射的总和会明显更低 —— 颜色虽然**不足以单独定案**
   * （实测这批图纸的填色和公开色板中位差 12.6），但它的**相对大小**仍携带信息，
   * 作为弱先验正合适。
   */
  const evaluate = (): number => {
    if (!opts.cost) {
      let hit = 0
      for (let gi = 0; gi < groups.length; gi++) {
        if (resolved[gi] && resolved[gi] === opts.prefer?.[gi]) hit += groups[gi].n
      }
      return -hit
    }
    let sum = 0
    for (let gi = 0; gi < groups.length; gi++) {
      const code = resolved[gi]
      sum += code ? opts.cost(gi, code) : 1000
    }
    return sum
  }

  /** 在 charOf 当前状态下，逐组解析出唯一的相容色号（多于一个就取代价最小的） */
  const resolved: (string | null)[] = new Array(groups.length).fill(null)
  const resolveAll = (): void => {
    for (let gi = 0; gi < groups.length; gi++) {
      const seq = seqs[gi]
      let best: string | null = null
      let bestC = Infinity
      for (const code of cands[gi]) {
        let ok = true
        for (let p = 0; p < seq.length; p++) {
          const known = charOf[seq[p]]
          if (known !== null && known !== code[p]) {
            ok = false
            break
          }
        }
        if (!ok) continue
        const c = opts.cost ? opts.cost(gi, code) : 0
        if (c < bestC) {
          bestC = c
          best = code
        }
      }
      resolved[gi] = best
    }
  }

  const dfs = (k: number): void => {
    if (nodes++ > maxNodes) return
    if (solutions >= 200) return
    if (k === order.length) {
      solutions++
      resolveAll()
      const sc = evaluate()
      if (sc < bestScore) {
        bestScore = sc
        bestChar = charOf.slice()
      }
      return
    }
    const cls = order[k]
    // 候选域：该类的每个位置，在所有「仍存活」的候选里出现过的字符之交集
    let dom: Set<string> | null = null
    for (const gi of groupsOfClass[cls]) {
      const positions = posOfClass[cls].get(gi) ?? []
      const set = new Set<string>()
      for (const code of cands[gi]) {
        if (!compatible(gi, code)) continue
        for (const p of positions) set.add(code[p])
      }
      if (dom === null) dom = set
      else for (const ch of [...dom]) if (!set.has(ch)) dom.delete(ch)
      if (dom.size === 0) return
    }
    if (!dom) return
    for (const ch of dom) {
      charOf[cls] = ch
      // 只复检受影响的那几个组
      let ok = true
      const touched = groupsOfClass[cls]
      const saved = new Uint8Array(touched.length)
      for (let t = 0; t < touched.length; t++) {
        const gi = touched[t]
        saved[t] = alive[gi]
        if (alive[gi] && !cands[gi].some((c) => compatible(gi, c))) {
          alive[gi] = 0
          ok = false
          break
        }
      }
      if (ok) dfs(k + 1)
      for (let t = 0; t < touched.length; t++) alive[touched[t]] = saved[t]
      charOf[cls] = null
      if (solutions >= 200) return
    }
  }
  dfs(0)

  const finalChar: (string | null)[] = bestChar ?? new Array(nClasses).fill(null)
  // 用最终映射算每组结果
  const codeOfGroup: (string | null)[] = []
  const compatibleCount: number[] = []
  let groupsResolved = 0
  let cellsCovered = 0
  let cellsTotal = 0
  let deadEnds = 0
  const compat = (gi: number, code: string): boolean => {
    const seq = seqs[gi]
    if (code.length !== seq.length) return false
    for (let p = 0; p < seq.length; p++) {
      const known = finalChar[seq[p]]
      if (known !== null && known !== code[p]) return false
    }
    return true
  }
  for (let gi = 0; gi < groups.length; gi++) {
    cellsTotal += groups[gi].n
    const ok = cands[gi].filter((c) => compat(gi, c))
    compatibleCount.push(ok.length)
    if (ok.length === 1) {
      codeOfGroup.push(ok[0])
      groupsResolved++
      cellsCovered += groups[gi].n
    } else {
      codeOfGroup.push(null)
      if (ok.length === 0 && cands[gi].length > 0) deadEnds++
    }
  }

  return {
    charOf: finalChar,
    codeOfGroup,
    compatibleCount,
    nodes,
    solutions,
    stats: {
      classes: nClasses,
      labeledClasses: finalChar.filter((c) => c !== null).length,
      groups: groups.length,
      groupsResolved,
      deadEnds,
      cellsCovered,
      cellsTotal,
    },
  }
}

export interface SolveOptions {
  /** 合法色号词表（221 或 291 体系的全部色号） */
  vocab: string[]
  /** 每组的颜色先验首选，仅用于在多个解之间挑最像的 */
  prefer?: string[]
  maxNodes?: number
  /** 某组解码成某色号的代价（用填色与色板的色差）；不给则退化成「首选命中数」 */
  cost?: (groupIndex: number, code: string) => number
}


/* ------------------------------------------------------------------ */
/* 按颜色组求解（真正的求解单元）                                        */
/* ------------------------------------------------------------------ */

/**
 * 颜色组：同一填色的所有格子。
 *
 * 实测同一填色的格子**100% 只读出一个色号**（哥伦比亚图纸 66 种填色，一致率 66/66）。
 * 所以不是 9090 格要认，而是 66 个色号要认 —— 而且每个颜色的填色是几千像素测出来的
 * 精确值，比逐格采样可靠得多。
 */
export interface ColorGroup {
  /** 填色 HEX，便于报告 */
  fill: string
  /** 该颜色包含多少格 */
  n: number
  /** 字形类序列（组内所有格子都一样） */
  seq: number[]
  /** 候选色号，按颜色距离由近到远 */
  candidates: string[]
}

export interface GroupLabelResult {
  /** 字形类 → 字符；解不出为 null */
  charOf: (string | null)[]
  /** 每个颜色组读出的色号；读不出为 null（调用方回退到颜色匹配） */
  codeOfGroup: (string | null)[]
  /** 每组在最终映射下相容的候选个数（1 = 唯一确定） */
  compatibleCount: number[]
  stats: {
    classes: number
    labeledClasses: number
    groups: number
    groupsResolved: number
    /** 候选全部不相容的组数（说明字形切分或词表有问题） */
    deadEnds: number
    cellsCovered: number
    cellsTotal: number
  }
}

/**
 * 用「全局一致性」给字形类贴标签，并读出每个颜色组的色号。
 *
 * 为什么按颜色组而不是按格子求解：同色同码（实测 100% 成立），
 * 一个组只需解一次；组数（66）远小于格数（9090），可以放心用很宽的候选集。
 *
 * 为什么不能只靠颜色先验：实测这批图纸的填色和任何一套公开色板都对不上
 * （中位距离 12.6），先验会把错的标签钉死、反而挡住正确答案
 * （实测按格子 + 先验只读出 46.5%，且个别字符标签是错的）。
 * 所以这里让**字形约束唱主角**，颜色只负责给出候选范围；
 * 最终仍解不出的组再回退到纯颜色匹配。
 */
export function labelGroups(groups: ColorGroup[], nClasses: number): GroupLabelResult {
  const charOf: (string | null)[] = new Array(nClasses).fill(null)

  const compatible = (seq: number[], code: string): boolean => {
    if (code.length !== seq.length) return false
    for (let p = 0; p < seq.length; p++) {
      const known = charOf[seq[p]]
      if (known !== null && known !== code[p]) return false
    }
    return true
  }

  for (let round = 0; round < 32; round++) {
    let changed = false
    for (const g of groups) {
      if (g.seq.length === 0 || g.seq.some((s) => s < 0)) continue
      const ok = g.candidates.filter((c) => compatible(g.seq, c))
      if (ok.length === 1) {
        const code = ok[0]
        for (let p = 0; p < g.seq.length; p++) {
          if (charOf[g.seq[p]] === null) {
            charOf[g.seq[p]] = code[p]
            changed = true
          }
        }
      }
    }
    if (!changed) break
  }

  const codeOfGroup: (string | null)[] = []
  const compatibleCount: number[] = []
  let groupsResolved = 0
  let cellsCovered = 0
  let cellsTotal = 0
  let deadEnds = 0
  for (const g of groups) {
    cellsTotal += g.n
    const usable = g.seq.length > 0 && !g.seq.some((s) => s < 0)
    const ok = usable ? g.candidates.filter((c) => compatible(g.seq, c)) : []
    compatibleCount.push(ok.length)
    if (ok.length === 1) {
      codeOfGroup.push(ok[0])
      groupsResolved++
      cellsCovered += g.n
    } else {
      codeOfGroup.push(null)
      if (usable && ok.length === 0 && g.candidates.length > 0) deadEnds++
    }
  }

  return {
    charOf,
    codeOfGroup,
    compatibleCount,
    stats: {
      classes: nClasses,
      labeledClasses: charOf.filter((c) => c !== null).length,
      groups: groups.length,
      groupsResolved,
      deadEnds,
      cellsCovered,
      cellsTotal,
    },
  }
}



