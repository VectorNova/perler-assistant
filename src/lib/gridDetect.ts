import type { DetectResult, GridSpec, RGB } from '../types'
import { deltaE2000, rgbToLab } from './color'
import { sampleCells } from './sample'

/* ------------------------------------------------------------------ *
 * 网格识别
 *
 * 1. 「细长脊」剖面（关键）：
 *      ridge(y,x) = |L[y][x] - L[y][x-d]| > m 且 |L[y][x] - L[y][x+d]| > m
 *    然后记录每一列 / 每一行上「属于长度 ≥ 3 的连续脊」的像素占比（覆盖率）。
 *    以列为单位、用左右邻居判断脊，检测的就是竖线；以行为单位、
 *    用上下邻居判断脊，检测的就是横线。
 *
 *    为什么不用简单的梯度计数：拼豆图纸每个格子里都印着色号文字，
 *    文字是深色短横线，会形成很强的、且与格距同周期的假脊，实测强度
 *    甚至超过真格线，会把相位整条带偏。
 *
 *    为什么用「覆盖率」而不是「最长连续长度」：格线在交叉处会被垂直方向的
 *    格线打断（交叉点上下 3 像素也是格线颜色，判据不成立），所以最长连续
 *    长度实际只有一个格子宽，反而没有区分度 —— 实测图例里 95 像素的短格线
 *    比图纸 22 像素的格线「最长连续」还长，直接把阈值带偏。覆盖率只被交叉点
 *    挖掉 1 像素，仍接近 1，而格内文字只有约 40% 覆盖率，区分度足够。
 *
 *    为什么要求「两侧都不同」：只比一侧深/浅的严格判据会漏掉浅灰格线压在
 *    深色格子上的情况；而「任一侧不同」又会在格线上下 ±d 像素形成一圈假脊
 *    （那一圈会把真峰值稀释掉）。两侧都要求，刚好两边都兼顾。
 *
 * 2. 归一化自相关求周期；再用「梳状得分」在约数候选里消倍频
 *    （图纸常见的强周期是真实格距的整数倍，例如每 5 格一条加粗分区线）。
 *
 * 3. 两轴互相印证：豆板是方的，两轴格距必须接近，用自相关更强的那个当基准。
 *
 * 4. 「格线处平均强度最大」定相位，再逐条微调 + 最小二乘拟合出小数精度格距。
 *
 * 5. 完全没有格线时（纯像素图）退回相邻像素梯度剖面。
 *
 * 6. 图纸范围优先用「图纸自带的加粗分区线」定（它精确）；否则用
 *    「内容包围盒」并尝试裁掉纯色的行号/列号标尺与装饰边框。
 *
 * 另外提供 `gridFromCellCount`：图纸标题通常直接写着格数
 * （例如「104x104/38色/共10816颗」），把这个数交给它，
 * 格距就退化成「图案尺寸 ÷ 格数」这个纯算术问题，比猜可靠得多。
 * ------------------------------------------------------------------ */

/** 细脊比较距离（像素） */
const RIDGE_D = 3
/** 判定「脊」的亮度差阈值 */
const RIDGE_MARGIN = 4
/** 只有长度不小于这个值的连续脊才计入（滤掉噪声产生的零星假脊） */
const MIN_RUN = 3
/** 采样行/列上限，限制大图检测耗时 */
const MAX_SAMPLES = 700
const MIN_PITCH = 4
/** 内容包围盒的候选格上限 */
const MAX_CANDIDATE_CELLS = 250000
/** 判定「这一格有内容」的色差阈值 */
const CONTENT_DELTA_E = 6

function buildLuminance(img: ImageData): Float32Array {
  const { width: W, height: H, data } = img
  const lum = new Float32Array(W * H)
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
  }
  return lum
}

interface Profiles {
  col: Float64Array
  row: Float64Array
}

/** 每一列 / 每一行的脊覆盖率（0..1） */
function buildRunProfiles(lum: Float32Array, W: number, H: number): Profiles {
  const d = Math.max(1, Math.min(RIDGE_D, Math.floor(Math.min(W, H) / 6)))
  const col = new Float64Array(W)
  const row = new Float64Array(H)
  const spanX = Math.max(1, W - 2 * d)
  const spanY = Math.max(1, H - 2 * d)

  const isRidge = (center: number, na: number, nb: number) =>
    Math.abs(center - na) > RIDGE_MARGIN && Math.abs(center - nb) > RIDGE_MARGIN

  // 竖线：逐列，用左右邻居判断脊，沿 y 统计覆盖率
  for (let x = d; x < W - d; x++) {
    let counted = 0
    let run = 0
    for (let y = d; y < H - d; y++) {
      const i = y * W + x
      if (isRidge(lum[i], lum[i - d], lum[i + d])) {
        run++
      } else {
        if (run >= MIN_RUN) counted += run
        run = 0
      }
    }
    if (run >= MIN_RUN) counted += run
    col[x] = counted / spanY
  }

  // 横线：逐行，用上下邻居判断脊，沿 x 统计覆盖率
  for (let y = d; y < H - d; y++) {
    let counted = 0
    let run = 0
    const base = y * W
    for (let x = d; x < W - d; x++) {
      const i = base + x
      if (isRidge(lum[i], lum[i - d * W], lum[i + d * W])) {
        run++
      } else {
        if (run >= MIN_RUN) counted += run
        run = 0
      }
    }
    if (run >= MIN_RUN) counted += run
    row[y] = counted / spanX
  }

  return { col, row }
}

/** 相邻像素梯度剖面：没有任何格线时（纯像素图）用色块边界定位网格 */
function buildStepProfiles(lum: Float32Array, W: number, H: number): Profiles {
  const col = new Float64Array(W)
  const row = new Float64Array(H)
  const stepY = Math.max(1, Math.floor(H / MAX_SAMPLES))
  const stepX = Math.max(1, Math.floor(W / MAX_SAMPLES))
  let nY = 0
  for (let y = 0; y < H; y += stepY) nY++
  let nX = 0
  for (let x = 0; x < W; x += stepX) nX++

  for (let x = 1; x < W - 1; x++) {
    let s = 0
    for (let y = 0; y < H; y += stepY) {
      const i = y * W + x
      s += Math.abs(lum[i + 1] - lum[i - 1])
    }
    col[x] = s / Math.max(1, nY)
  }
  for (let y = 1; y < H - 1; y++) {
    let s = 0
    for (let x = 0; x < W; x += stepX) {
      const i = y * W + x
      s += Math.abs(lum[i + W] - lum[i - W])
    }
    row[y] = s / Math.max(1, nX)
  }
  return { col, row }
}

function stats(p: Float64Array): { mean: number; std: number; max: number } {
  let sum = 0
  let max = 0
  for (let i = 0; i < p.length; i++) {
    sum += p[i]
    if (p[i] > max) max = p[i]
  }
  const mean = sum / p.length
  let v = 0
  for (let i = 0; i < p.length; i++) {
    const dd = p[i] - mean
    v += dd * dd
  }
  return { mean, std: Math.sqrt(v / p.length), max }
}

function autocorrelation(p: Float64Array, maxLag: number): Float64Array {
  const n = p.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += p[i]
  mean /= n

  const d = new Float64Array(n)
  let v0 = 0
  for (let i = 0; i < n; i++) {
    d[i] = p[i] - mean
    v0 += d[i] * d[i]
  }

  const r = new Float64Array(maxLag + 1)
  if (v0 <= 0) return r
  const base = v0 / n
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0
    const cnt = n - lag
    for (let i = 0; i < cnt; i++) s += d[i] * d[i + lag]
    r[lag] = s / cnt / base
  }
  return r
}

/** 某个周期 q 下，格点处（允许 ±1 像素相位抖动）能达到的最大平均强度 */
function combScore(prof: Float64Array, q: number): number {
  const n = prof.length
  const search = Math.max(1, Math.round(q))
  let best = 0
  for (let o = 0; o < search; o++) {
    let s = 0
    let c = 0
    for (let x = o; x < n; x += q) {
      const xi = Math.round(x)
      if (xi < 1 || xi >= n - 1) continue
      let v = prof[xi]
      if (prof[xi - 1] > v) v = prof[xi - 1]
      if (prof[xi + 1] > v) v = prof[xi + 1]
      s += v
      c++
    }
    if (c >= 3) {
      const m = s / c
      if (m > best) best = m
    }
  }
  return best
}

/**
 * 候选周期 + 梳状得分。div 从 1 到 8：
 * 图纸上常见的强周期是真实格距的整数倍（例如每 5 格一条加粗分区线，
 * 自相关就会锁到 5 倍），所以要在约数里找真正的基频。
 */
interface PitchCand {
  q: number
  s: number
}

function pitchCandidates(prof: Float64Array, p: number): PitchCand[] {
  const cands: PitchCand[] = []
  for (let div = 1; div <= 8; div++) {
    const q = p / div
    if (q < MIN_PITCH) break
    cands.push({ q, s: combScore(prof, q) })
  }
  cands.sort((a, b) => a.q - b.q)
  return cands
}

/**
 * 从候选里挑周期。
 * - 不给 target：挑「最小的、但得分仍接近最高分」的那个（消倍频）。
 * - 给了 target（另一轴的可信格距）：优先挑格距接近 target 的 —— 豆板是方的，
 *   两轴格距必须接近。这一条能把「被格内色号文字的笔画间距带偏」的候选排掉：
 *   实测某图纸真实格距 13.6px，但格内文字横笔画间距约 5.4px，
 *   自相关锁到 2 倍频 27 之后再除以 5 就得到 5.4，只有靠另一轴才能纠回来。
 */
function pickFromCandidates(cands: PitchCand[], target?: number): number {
  if (cands.length === 0) return 0
  let maxS = 0
  for (const c of cands) if (c.s > maxS) maxS = c.s
  if (maxS <= 0) return 0

  if (target && target > 0) {
    let bestQ = 0
    let bestScore = -Infinity
    for (const c of cands) {
      if (c.s < maxS * 0.6) continue
      const rel = Math.abs(c.q - target) / target
      const score = c.s / maxS - rel * 2
      if (score > bestScore) {
        bestScore = score
        bestQ = c.q
      }
    }
    if (bestQ > 0) return bestQ
  }

  // cands 已按 q 升序：挑最小的、得分不低于最高分 90% 的基频
  for (const c of cands) {
    if (c.s >= maxS * 0.9) return c.q
  }
  return cands[cands.length - 1].q
}

/** 取让格点平均强度最大的相位（格线原点的小数部分） */
function bestPhase(prof: Float64Array, pitch: number): number {
  const n = prof.length
  const search = Math.max(1, Math.round(pitch))
  let bestOffset = 0
  let bestSum = -Infinity
  for (let o = 0; o < search; o++) {
    let sum = 0
    let cnt = 0
    for (let x = o; x < n; x += pitch) {
      const xi = Math.round(x)
      if (xi < 1 || xi >= n - 1) continue
      sum += prof[xi]
      cnt++
    }
    if (cnt < 3) continue
    const avg = sum / cnt
    if (avg > bestSum) {
      bestSum = avg
      bestOffset = o
    }
  }
  return bestOffset
}

/** 内容像素包围盒：与页面背景色差异明显的像素的范围 */
function contentBBoxPixels(
  img: ImageData,
  bg: RGB,
  tol = 30,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const { width: W, height: H, data } = img
  let x0 = W
  let y0 = H
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < H; y++) {
    let p = y * W * 4
    for (let x = 0; x < W; x++, p += 4) {
      const d =
        Math.abs(data[p] - bg[0]) + Math.abs(data[p + 1] - bg[1]) + Math.abs(data[p + 2] - bg[2])
      if (d > tol) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0 || y1 < 0) return null
  return { x0, y0, x1, y1 }
}

/** 没有任何可拟合格线时的兜底：用已知周期 + 相位，配合内容包围盒拼出网格 */
function gridFromPeriods(
  img: ImageData,
  bX: number,
  phX: number,
  bY: number,
  phY: number,
  bg: RGB,
): GridSpec | null {
  const bbox = contentBBoxPixels(img, bg)
  if (!bbox) return null
  const w = bbox.x1 - bbox.x0 + 1
  const h = bbox.y1 - bbox.y0 + 1
  if (w < bX || h < bY) return null
  const cols = Math.max(1, Math.round(w / bX))
  const rows = Math.max(1, Math.round(h / bY))
  const offsetX = phX + bX * Math.round((bbox.x0 - phX) / bX)
  const offsetY = phY + bY * Math.round((bbox.y0 - phY) / bY)
  return { offsetX, offsetY, cellW: bX, cellH: bY, cols, rows }
}

/**
 * 两轴周期互相印证。
 * 拼豆图纸的格子几乎总是正方形的（豆板本身是方的），所以如果两轴算出来的
 * 周期差很多、而大的正好是小的整数倍，那多半是大的那一轴被自相关锁到了
 * 整数倍上（大片同色 / 加粗分区线时很常见）。
 */
function harmonizePitches(pX: number, pY: number): [number, number] {
  if (pX <= 0 || pY <= 0) return [pX, pY]
  const big = Math.max(pX, pY)
  const small = Math.min(pX, pY)
  if (big / small < 1.15) return [pX, pY]
  // 在所有可能的整数倍里找拟合最好的那个（不只看四舍五入的那个）
  let bestK = 0
  let bestErr = Infinity
  for (let k = 2; k <= 8; k++) {
    const err = Math.abs(big / k - small) / small
    if (err < bestErr) {
      bestErr = err
      bestK = k
    }
  }
  if (bestK > 0 && bestErr < 0.08) {
    return pX > pY ? [small, pY] : [pX, small]
  }
  return [pX, pY]
}

function parabolicPeak(r: Float64Array, lag: number): number {
  if (lag <= 0 || lag >= r.length - 1) return lag
  const y0 = r[lag - 1]
  const y1 = r[lag]
  const y2 = r[lag + 1]
  const denom = y0 - 2 * y1 + y2
  if (Math.abs(denom) < 1e-12) return lag
  const delta = (0.5 * (y0 - y2)) / denom
  return lag + Math.max(-0.5, Math.min(0.5, delta))
}

/** 取第一个强度达到全局峰值 55% 的局部极大值，只做自相关定位，不做倍频消解 */
function estimateRawPitch(
  prof: Float64Array,
  minPitch = MIN_PITCH,
): { pitch: number; strength: number } {
  const n = prof.length
  const maxLag = Math.min(Math.floor(n / 2), Math.max(64, Math.floor(n / 3)))
  if (maxLag <= minPitch) return { pitch: 0, strength: 0 }

  const r = autocorrelation(prof, maxLag)
  let maxR = 0
  for (let lag = minPitch; lag <= maxLag; lag++) if (r[lag] > maxR) maxR = r[lag]
  if (maxR <= 0.05) return { pitch: 0, strength: maxR }

  const thr = maxR * 0.55
  let found = 0
  for (let lag = minPitch; lag <= maxLag; lag++) {
    const isPeak = r[lag] >= r[lag - 1] && (lag === maxLag || r[lag] >= r[lag + 1])
    if (isPeak && r[lag] >= thr) {
      found = lag
      break
    }
  }
  if (found === 0) {
    for (let lag = minPitch; lag <= maxLag; lag++) {
      if (r[lag] === maxR) {
        found = lag
        break
      }
    }
  }
  if (found === 0) return { pitch: 0, strength: maxR }
  return { pitch: parabolicPeak(r, found), strength: maxR }
}

interface LineFit {
  a: number
  b: number
  count: number
  strength: number
}

/** 定相位 → 逐条微调 → 最小二乘拟合出小数精度格距 */
function fitLines(
  prof: Float64Array,
  pitch: number,
  st: { mean: number; std: number; max: number },
): LineFit | null {
  const n = prof.length
  if (pitch < MIN_PITCH) return null

  const search = Math.max(1, Math.round(pitch))
  let bestOffset = 0
  let bestSum = -Infinity
  for (let o = 0; o < search; o++) {
    let sum = 0
    let cnt = 0
    for (let x = o; x < n; x += pitch) {
      const xi = Math.round(x)
      if (xi < 1 || xi >= n - 1) continue
      sum += prof[xi]
      cnt++
    }
    if (cnt < 3) continue
    const avg = sum / cnt
    if (avg > bestSum) {
      bestSum = avg
      bestOffset = o
    }
  }
  if (bestSum === -Infinity) return null

  const thr = Math.max(st.mean + 1.1 * st.std, 0.3 * st.max)
  const halfWin = Math.max(1, Math.round(pitch * 0.3))

  const ks: number[] = []
  const lines: number[] = []
  const kMax = Math.ceil(n / pitch) + 1
  for (let k = -1; k <= kMax; k++) {
    const approx = bestOffset + k * pitch
    if (approx < 1 || approx > n - 2) continue
    const lo = Math.max(1, Math.round(approx) - halfWin)
    const hi = Math.min(n - 2, Math.round(approx) + halfWin)
    let bestPos = -1
    let bestVal = -Infinity
    for (let x = lo; x <= hi; x++) {
      if (prof[x] > bestVal) {
        bestVal = prof[x]
        bestPos = x
      }
    }
    if (bestPos < 0 || bestVal < thr) continue
    ks.push(k)
    lines.push(bestPos)
  }
  if (lines.length < 3) return null

  let a = 0
  let b = pitch
  const fitOnce = (kk: number[], yy: number[]) => {
    const m = kk.length
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    for (let i = 0; i < m; i++) {
      sx += kk[i]
      sy += yy[i]
      sxx += kk[i] * kk[i]
      sxy += kk[i] * yy[i]
    }
    const denom = m * sxx - sx * sx
    if (Math.abs(denom) < 1e-9) {
      a = sy / m
      b = pitch
    } else {
      b = (m * sxy - sx * sy) / denom
      a = (sy - b * sx) / m
    }
  }

  fitOnce(ks, lines)
  let count = lines.length
  for (let pass = 0; pass < 2; pass++) {
    const keepK: number[] = []
    const keepL: number[] = []
    for (let i = 0; i < ks.length; i++) {
      if (Math.abs(lines[i] - (a + b * ks[i])) <= Math.max(1.5, b * 0.2)) {
        keepK.push(ks[i])
        keepL.push(lines[i])
      }
    }
    if (keepK.length < 3) break
    fitOnce(keepK, keepL)
    count = keepK.length
  }

  if (b < MIN_PITCH) return null
  return { a, b, count, strength: bestSum / (st.max || 1) }
}

function longestRun(ks: number[], maxGap = 2): { start: number; end: number } {
  if (ks.length === 0) return { start: 0, end: -1 }
  const sorted = [...ks].sort((x, y) => x - y)
  let bestStart = sorted[0]
  let bestEnd = sorted[0]
  let curStart = sorted[0]
  let curEnd = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - curEnd <= maxGap + 1) {
      curEnd = sorted[i]
    } else {
      if (curEnd - curStart > bestEnd - bestStart) {
        bestStart = curStart
        bestEnd = curEnd
      }
      curStart = sorted[i]
      curEnd = sorted[i]
    }
  }
  if (curEnd - curStart > bestEnd - bestStart) {
    bestStart = curStart
    bestEnd = curEnd
  }
  return { start: bestStart, end: bestEnd }
}

/**
 * Prefer a complete lattice when it covers nearly all of the tolerant run.
 * A legend often starts one empty row below a chart and happens to align with
 * the same pitch. Joining across that empty row adds the legend to the pattern.
 * Keep the tolerant run for charts whose faint/occluded lines really do have
 * several gaps; a short uninterrupted fragment must not crop such a chart.
 */
function dominantLineRun(ks: number[]): { start: number; end: number } {
  const tolerant = longestRun(ks)
  const continuous = longestRun(ks, 0)
  const span = tolerant.end - tolerant.start
  if (span > 0 && continuous.end - continuous.start >= span * 0.85) return continuous
  return tolerant
}

/** 从剖面里重新收集落在阈值之上的格线索引（用于格线区段模式） */
function collectKs(prof: Float64Array, a: number, b: number): number[] {
  const st = stats(prof)
  const thr = Math.max(st.mean + 1.1 * st.std, 0.3 * st.max)
  const halfWin = Math.max(1, Math.round(b * 0.3))
  const n = prof.length
  const ks: number[] = []
  const kMin = Math.floor((1 - a) / b) - 1
  const kMax = Math.ceil((n - 2 - a) / b) + 1
  for (let k = kMin; k <= kMax; k++) {
    const approx = a + b * k
    if (approx < 1 || approx > n - 2) continue
    const lo = Math.max(1, Math.round(approx) - halfWin)
    const hi = Math.min(n - 2, Math.round(approx) + halfWin)
    let best = -Infinity
    for (let x = lo; x <= hi; x++) if (prof[x] > best) best = prof[x]
    if (best >= thr) ks.push(k)
  }
  return ks
}

/**
 * 内容包围盒（以「格」为单位）。
 * 图例表格里的细线占不满一格，格子的主色仍是背景色，因此会被自然排除。
 */
function contentExtent(
  img: ImageData,
  aX: number,
  bX: number,
  aY: number,
  bY: number,
  pageBg: RGB,
): { minC: number; maxC: number; minR: number; maxR: number; count: number } | null {
  const { width: W, height: H } = img
  const nCols = Math.max(1, Math.ceil((W - aX) / bX) + 1)
  const nRows = Math.max(1, Math.ceil((H - aY) / bY) + 1)
  if (nCols * nRows > MAX_CANDIDATE_CELLS) return null

  const cand: GridSpec = { offsetX: aX, offsetY: aY, cellW: bX, cellH: bY, cols: nCols, rows: nRows }
  const { rgb, purity } = sampleCells(img, cand)
  const bgLab = rgbToLab(pageBg)

  let minC = Infinity
  let maxC = -1
  let minR = Infinity
  let maxR = -1
  let count = 0
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const i = r * nCols + c
      if (purity[i] <= 0) continue
      const col: RGB = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]
      if (deltaE2000(rgbToLab(col), bgLab) <= CONTENT_DELTA_E) continue
      count++
      if (c < minC) minC = c
      if (c > maxC) maxC = c
      if (r < minR) minR = r
      if (r > maxR) maxR = r
    }
  }
  if (maxC < 0 || maxR < 0 || count < 4) return null
  return { minC, maxC, minR, maxR, count }
}

/** 遍历图像最外圈的一条窄带 */
function forEachBorderPixel(img: ImageData, cb: (r: number, g: number, b: number) => void) {
  const { width: W, height: H, data } = img
  const band = Math.max(2, Math.round(Math.min(W, H) * 0.008))
  const at = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const p = (y * W + x) * 4
    cb(data[p], data[p + 1], data[p + 2])
  }
  for (let x = 0; x < W; x += 2) {
    for (let d = 0; d < band; d++) {
      at(x, d)
      at(x, H - 1 - d)
    }
  }
  for (let y = 0; y < H; y += 2) {
    for (let d = 0; d < band; d++) {
      at(d, y)
      at(W - 1 - d, y)
    }
  }
}

/**
 * 图像最外圈是否是基本单一颜色（即图纸四周有留白边距）。
 * 用「均值 + 逐通道容差」而不是颜色分桶，否则带噪声的纯色边距会被
 * 分桶边界劈成两半，误判成「没有留白」。
 */
function borderUniformity(img: ImageData): { uniform: boolean; color: RGB } {
  let n = 0
  let sr = 0
  let sg = 0
  let sb = 0
  forEachBorderPixel(img, (r, g, b) => {
    sr += r
    sg += g
    sb += b
    n++
  })
  if (n === 0) return { uniform: false, color: [255, 255, 255] }
  const mr = sr / n
  const mg = sg / n
  const mb = sb / n
  let within = 0
  forEachBorderPixel(img, (r, g, b) => {
    if (Math.abs(r - mr) + Math.abs(g - mg) + Math.abs(b - mb) <= 30) within++
  })
  return {
    uniform: within / n > 0.92,
    color: [Math.round(mr), Math.round(mg), Math.round(mb)],
  }
}

/**
 * 用「内容占比」找图案主体的包围盒。
 * 图纸上除了图案还有标题、logo、底部色号图例、行号/列号标尺、装饰边框，
 * 它们都只占局部，而图案主体是横贯整幅的一大片。所以按行/列统计
 * 「非背景像素占比」，取最长的连续高占比区段。
 *
 * 阈值要够高（默认 0.75）：标题那几行文字能占到宽度六成，用 0.5 会把标题
 * 也圈进来，原点就会整体上移一两格，整张图纸的采样全部错位。
 */
export function patternBoxByContent(
  img: ImageData,
  bg: RGB,
  tol = 22,
  thr = 0.75,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const { width: W, height: H, data } = img
  const diff = (p: number) =>
    Math.abs(data[p] - bg[0]) + Math.abs(data[p + 1] - bg[1]) + Math.abs(data[p + 2] - bg[2]) > tol

  const rowFrac = new Float32Array(H)
  for (let y = 0; y < H; y++) {
    let n = 0
    let p = y * W * 4
    for (let x = 0; x < W; x++, p += 4) if (diff(p)) n++
    rowFrac[y] = n / W
  }
  const colFrac = new Float32Array(W)
  for (let x = 0; x < W; x++) {
    let n = 0
    for (let y = 0; y < H; y++) if (diff((y * W + x) * 4)) n++
    colFrac[x] = n / H
  }

  const rows = longestHighRun(rowFrac, thr, Math.max(16, Math.round(H * 0.2)))
  const cols = longestHighRun(colFrac, thr, Math.max(16, Math.round(W * 0.2)))
  if (!rows || !cols) return null
  return { x0: cols.start, x1: cols.end, y0: rows.start, y1: rows.end }
}

/** 最长的连续「占比 > thr」区段，允许中间有 ≤3 的空隙；太短的不要 */
function longestHighRun(
  frac: Float32Array,
  thr: number,
  minLen: number,
): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null
  let start = -1
  let gap = 0
  const consider = (end: number) => {
    if (start < 0) return
    if (end - start + 1 >= minLen && (!best || end - start > best.end - best.start)) {
      best = { start, end }
    }
  }
  for (let i = 0; i < frac.length; i++) {
    if (frac[i] > thr) {
      if (start < 0) start = i
      gap = 0
    } else if (start >= 0) {
      gap++
      if (gap > 3) {
        consider(i - gap)
        start = -1
        gap = 0
      }
    }
  }
  consider(frac.length - 1)
  return best
}

/**
 * 从包围盒四边向内裁掉「纯色带」。
 * 这类图纸在图案外侧有一圈蓝底的行号/列号标尺，还有装饰边框 ——
 * 它们也满足「非背景占比高」，会被算进包围盒，导致原点整体偏一两格。
 * 图案本身每行每列颜色都很杂，所以「接近单色」就是标尺/边框的判据。
 * 只用于没有加粗分区线可用的兜底路径。
 */
function trimSolidEdges(
  img: ImageData,
  box: { x0: number; y0: number; x1: number; y1: number },
  solidShare = 0.8,
): { x0: number; y0: number; x1: number; y1: number } {
  const { width: W, data } = img
  const out = { ...box }

  const rowSolid = (y: number): boolean => {
    const hist = new Map<number, number>()
    let n = 0
    let p = (y * W + out.x0) * 4
    for (let x = out.x0; x <= out.x1; x++, p += 4) {
      const k = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3)
      hist.set(k, (hist.get(k) ?? 0) + 1)
      n++
    }
    let best = 0
    for (const v of hist.values()) if (v > best) best = v
    return n > 0 && best / n >= solidShare
  }
  const colSolid = (x: number): boolean => {
    const hist = new Map<number, number>()
    let n = 0
    for (let y = out.y0; y <= out.y1; y++) {
      const p = (y * W + x) * 4
      const k = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3)
      hist.set(k, (hist.get(k) ?? 0) + 1)
      n++
    }
    let best = 0
    for (const v of hist.values()) if (v > best) best = v
    return n > 0 && best / n >= solidShare
  }

  const maxTrimX = Math.floor((out.x1 - out.x0) * 0.25)
  const maxTrimY = Math.floor((out.y1 - out.y0) * 0.25)
  let t = 0
  while (t < maxTrimX && out.x0 < out.x1 && colSolid(out.x0)) {
    out.x0++
    t++
  }
  t = 0
  while (t < maxTrimX && out.x1 > out.x0 && colSolid(out.x1)) {
    out.x1--
    t++
  }
  t = 0
  while (t < maxTrimY && out.y0 < out.y1 && rowSolid(out.y0)) {
    out.y0++
    t++
  }
  t = 0
  while (t < maxTrimY && out.y1 > out.y0 && rowSolid(out.y1)) {
    out.y1--
    t++
  }
  return out
}

/**
 * 检测图纸自带的加粗分区线（通常是橙红色，每 N 格一条）。
 *
 * 这类标注非常有用：横向分区线横贯整个图案，所以它们的 x 范围就是图案的
 * 左右边界；纵向分区线的 y 范围就是图案的上下边界 —— 比「内容包围盒」
 * 精确得多，因为包围盒会把外圈的行号/列号标尺和装饰边框也算进去。
 * 间距还给出了一个高精度的尺子，可以把格距吸附到「间距 ÷ 整数」。
 */
interface SectionFrame {
  x0: number
  x1: number
  y0: number
  y1: number
  spacingX: number
  spacingY: number
  lineCountX: number
  lineCountY: number
  /** 第一条竖线 / 横线的中心位置（通常就是图案的左/上边界，精度远高于内容包围盒） */
  firstLineX: number
  firstLineY: number
}

function detectSectionFrame(img: ImageData): SectionFrame | null {
  const { width: W, height: H, data } = img
  const isRed = (p: number) => {
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    return r > 120 && r > g + 22 && r > b + 22
  }

  const redCol = new Int32Array(W)
  const redRow = new Int32Array(H)
  for (let y = 0; y < H; y++) {
    let p = y * W * 4
    for (let x = 0; x < W; x++, p += 4) {
      if (isRed(p)) {
        redCol[x]++
        redRow[y]++
      }
    }
  }

  // 用「占图像尺寸的比例」做绝对阈值，而不是相对最大值：
  // 相对最大值会被标题/logo 里的红橙色像素带偏，把标题行也当成分区线。
  // 真正的分区线一定横贯图案的绝大部分。
  const lineRows: number[] = []
  for (let y = 0; y < H; y++) if (redRow[y] >= W * 0.35) lineRows.push(y)
  const lineCols: number[] = []
  for (let x = 0; x < W; x++) if (redCol[x] >= H * 0.35) lineCols.push(x)
  const rowGroups = groupConsecutive(lineRows)
  const colGroups = groupConsecutive(lineCols)
  if (colGroups.length < 3 || rowGroups.length < 3) return null

  // 逐条线各自量范围，再取中位数 —— 个别被污染的线不会把整体范围拉偏
  const median = (a: number[]) => {
    if (a.length === 0) return NaN
    const s = [...a].sort((x, y) => x - y)
    return s[Math.floor(s.length / 2)]
  }
  const rowLo: number[] = []
  const rowHi: number[] = []
  for (const g of rowGroups) {
    for (const y of g) {
      let lo = W
      let hi = -1
      let p = y * W * 4
      for (let x = 0; x < W; x++, p += 4) {
        if (isRed(p)) {
          if (x < lo) lo = x
          if (x > hi) hi = x
        }
      }
      if (hi >= 0) {
        rowLo.push(lo)
        rowHi.push(hi)
      }
    }
  }
  const colLo: number[] = []
  const colHi: number[] = []
  for (const g of colGroups) {
    for (const x of g) {
      let lo = H
      let hi = -1
      for (let y = 0; y < H; y++) {
        if (isRed((y * W + x) * 4)) {
          if (y < lo) lo = y
          if (y > hi) hi = y
        }
      }
      if (hi >= 0) {
        colLo.push(lo)
        colHi.push(hi)
      }
    }
  }
  const x0 = Math.round(median(rowLo))
  const x1 = Math.round(median(rowHi))
  const y0 = Math.round(median(colLo))
  const y1 = Math.round(median(colHi))
  if (!Number.isFinite(x0) || !Number.isFinite(y1) || x1 - x0 < 16 || y1 - y0 < 16) return null

  const centers = (groups: number[][]) => groups.map((g) => g[0] + (g.length - 1) / 2)
  const colCenters = centers(colGroups)
  const rowCenters = centers(rowGroups)
  const spacing = (cs: number[]) => {
    if (cs.length < 3) return 0
    const gaps: number[] = []
    for (let i = 1; i < cs.length; i++) gaps.push(cs[i] - cs[i - 1])
    gaps.sort((a, b) => a - b)
    return gaps[Math.floor(gaps.length / 2)]
  }

  return {
    x0,
    x1,
    y0,
    y1,
    spacingX: spacing(colCenters),
    spacingY: spacing(rowCenters),
    lineCountX: colGroups.length,
    lineCountY: rowGroups.length,
    firstLineX: colCenters[0],
    firstLineY: rowCenters[0],
  }
}

/** 把连续（间隔 ≤2）的下标聚成一组 */
function groupConsecutive(sorted: number[]): number[][] {
  const out: number[][] = []
  let cur: number[] = []
  for (const v of sorted) {
    if (cur.length === 0 || v - cur[cur.length - 1] <= 2) cur.push(v)
    else {
      out.push(cur)
      cur = [v]
    }
  }
  if (cur.length > 0) out.push(cur)
  return out
}

/**
 * 按「图纸上标注的格数」反推网格。
 *
 * 拼豆图纸的标题通常直接写着「原神奥黛塔 [104x104/38色/共10816颗]」。
 * 把这几个数读出来输进去，比让算法从像素里猜格距可靠得多 ——
 * 尤其是「格内印满色号文字、格线又很淡」的图纸，自相关很容易被文字的
 * 笔画间距带偏（实测真实格距 13.6px 会被锁成 5.3px 或 21.2px）。
 *
 * 步骤：
 *  1. 优先用图纸自带的加粗分区线定图案边界（横线给左右、竖线给上下），
 *     并把格距吸附到「分区线间距 ÷ 整数」；
 *  2. 没有分区线时退回「内容占比包围盒」并裁掉纯色标尺/边框；
 *  3. 相位用「色块边界」剖面精修，比直接用包围盒角点准。
 */
export function gridFromCellCount(
  img: ImageData,
  cols: number,
  rows: number,
): {
  grid: GridSpec
  box: { x0: number; y0: number; x1: number; y1: number }
  qX: number
  qY: number
  px: number
  py: number
  snapped: string
} | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return null
  // Count is a constraint, not permission to stretch a box that includes rulers.
  // When the full-resolution line lattice already satisfies it, use those exact
  // boundaries. Section-line endpoints can include the numbering strips, and
  // their first line can be several cells inside the actual pattern.
  const detected = detectGrid(img)
  if (
    detected.confidence >= 0.65 &&
    detected.grid.cols === Math.round(cols) &&
    detected.grid.rows === Math.round(rows)
  ) {
    const grid = detected.grid
    return {
      grid,
      box: {
        x0: grid.offsetX,
        y0: grid.offsetY,
        x1: grid.offsetX + grid.cols * grid.cellW - 1,
        y1: grid.offsetY + grid.rows * grid.cellH - 1,
      },
      qX: grid.cellW,
      qY: grid.cellH,
      px: ((grid.offsetX % grid.cellW) + grid.cellW) % grid.cellW,
      py: ((grid.offsetY % grid.cellH) + grid.cellH) % grid.cellH,
      snapped: `完整格线与标注格数一致，沿用格线定位（${grid.cols}×${grid.rows}）\n${detected.debug ?? ''}`,
    }
  }
  const bg = estimatePageBackground(img)
  const notes: string[] = []

  const frame = detectSectionFrame(img)
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null
  let qX = 0
  let qY = 0
  if (frame) {
    box = { x0: frame.x0, y0: frame.y0, x1: frame.x1, y1: frame.y1 }
    qX = (box.x1 - box.x0 + 1) / cols
    qY = (box.y1 - box.y0 + 1) / rows
    notes.push(
      `用加粗分区线定边界：x ${box.x0}..${box.x1} y ${box.y0}..${box.y1}` +
        `（列 ${frame.lineCountX} 条 / 行 ${frame.lineCountY} 条，间距 ${frame.spacingX}/${frame.spacingY}px）`,
    )
    const snap = (q: number, spacing: number, tag: string): number => {
      if (spacing <= 0 || spacing <= q * 1.3) return q
      const m = Math.round(spacing / q)
      if (m < 2) return q
      const cand = spacing / m
      if (Math.abs(cand - q) / q > 0.3) return q
      notes.push(`${tag}格距吸附：分区线间距 ${spacing}px ÷ ${m} = ${cand.toFixed(2)}px`)
      return cand
    }
    qX = snap(qX, frame.spacingX, '列')
    qY = snap(qY, frame.spacingY, '行')
  } else {
    const rawBox = patternBoxByContent(img, bg)
    if (!rawBox) return null
    box = trimSolidEdges(img, rawBox)
    qX = (box.x1 - box.x0 + 1) / cols
    qY = (box.y1 - box.y0 + 1) / rows
    notes.push(
      `未检测到加粗分区线，改用内容包围盒（已尝试裁掉纯色标尺/边框）：` +
        `x ${box.x0}..${box.x1} y ${box.y0}..${box.y1}`,
    )
  }
  if (!box || qX < MIN_PITCH || qY < MIN_PITCH) return null

  const lum = buildLuminance(img)
  const step = buildStepProfiles(lum, img.width, img.height)
  let px = bestPhase(step.col, qX)
  let py = bestPhase(step.row, qY)
  let offsetX = px + qX * Math.round((box.x0 - px) / qX)
  let offsetY = py + qY * Math.round((box.y0 - py) / qY)

  // 有分区线时直接用它定原点：第一条分区线一般就压在图案边界上，
  // 精度是像素级，比「包围盒角点」和「色块边界剖面」都准。
  // （实测某实拍图纸：包围盒给的原点是 231，色块边界剖面给 2.0（对应 233.2），
  //   而第一条横分区线在 242 —— 两者都差一格，会让整张图纸的采样整体上移一格。）
  // 守卫：只有当第一条分区线落在包围盒边界附近（≤1.6 格）时才采信，
  // 避免图纸从分区线之前几格开始的情况被强行对齐。
  if (frame) {
    if (Math.abs(frame.firstLineX - box.x0) <= 1.6 * qX) {
      offsetX = frame.firstLineX
      px = ((frame.firstLineX % qX) + qX) % qX
    }
    if (Math.abs(frame.firstLineY - box.y0) <= 1.6 * qY) {
      offsetY = frame.firstLineY
      py = ((frame.firstLineY % qY) + qY) % qY
    }
  }

  return {
    grid: {
      offsetX,
      offsetY,
      cellW: qX,
      cellH: qY,
      cols: Math.round(cols),
      rows: Math.round(rows),
    },
    box,
    qX,
    qY,
    px,
    py,
    snapped: notes.join('\n'),
  }
}

export function detectGrid(img: ImageData): DetectResult {
  const { width: W, height: H } = img
  const fallback: GridSpec = {
    offsetX: 0,
    offsetY: 0,
    cellW: Math.max(MIN_PITCH, Math.round(W / 32)),
    cellH: Math.max(MIN_PITCH, Math.round(H / 32)),
    cols: 32,
    rows: 32,
  }
  if (W < 16 || H < 16) {
    return { grid: fallback, confidence: 0, lineXs: [], lineYs: [], debug: '图像过小' }
  }

  const lum = buildLuminance(img)
  const runP = buildRunProfiles(lum, W, H)
  let colProf = runP.col
  let rowProf = runP.row
  let colRaw = estimateRawPitch(colProf)
  let rowRaw = estimateRawPitch(rowProf)
  let profileMode = '格线脊'

  // 完全没有格线（纯像素图）：退回色块边界梯度剖面
  if (Math.max(colRaw.strength, rowRaw.strength) < 0.3) {
    const stepP = buildStepProfiles(lum, W, H)
    const sc = estimateRawPitch(stepP.col)
    const sr = estimateRawPitch(stepP.row)
    if (sc.strength > colRaw.strength) {
      colProf = stepP.col
      colRaw = sc
      profileMode += '+列梯度'
    }
    if (sr.strength > rowRaw.strength) {
      rowProf = stepP.row
      rowRaw = sr
      profileMode += '+行梯度'
    }
  }

  // ---- 定周期：三层保险 ----
  // 1) 两轴若成整数倍关系（同一套加粗分区线的倍频），先归到小的那个
  const [hx, hy] = harmonizePitches(colRaw.pitch, rowRaw.pitch)
  if (hx !== colRaw.pitch) colRaw = { pitch: hx, strength: colRaw.strength }
  if (hy !== rowRaw.pitch) rowRaw = { pitch: hy, strength: rowRaw.strength }

  // 2) 各自在约数候选里消倍频
  const colCands = colRaw.pitch >= MIN_PITCH ? pitchCandidates(colProf, colRaw.pitch) : []
  const rowCands = rowRaw.pitch >= MIN_PITCH ? pitchCandidates(rowProf, rowRaw.pitch) : []
  let px = pickFromCandidates(colCands)
  let py = pickFromCandidates(rowCands)

  // 3) 豆板是方的：两轴格距必须接近，在另一轴的候选里挑最接近基准的。
  //    这一步专治「格内文字的笔画间距把周期带偏」：实测某图纸真实格距 13.6px，
  //    行方向自相关锁到 21.2px，而 21.2 的约数候选里根本没有 13.6。
  //    注意：不能拿「采样纯度」当判据 —— 格距偏小时每格只是真格子的一条，
  //    反而更「纯」，纯度会把格距往小里带（实测 5.3 的纯度高于 13.6）。
  let pitchNote = ''
  if (px >= MIN_PITCH && py >= MIN_PITCH && Math.abs(px - py) / Math.max(px, py) > 0.08) {
    const colIsAnchor = colRaw.strength >= rowRaw.strength
    const anchor = colIsAnchor ? px : py
    const cands = colIsAnchor ? rowCands : colCands
    let maxS = 0
    for (const c of cands) if (c.s > maxS) maxS = c.s
    let best = 0
    let bestRel = Infinity
    for (const c of cands) {
      if (maxS > 0 && c.s < maxS * 0.6) continue
      const rel = Math.abs(c.q - anchor) / anchor
      if (rel < bestRel) {
        bestRel = rel
        best = c.q
      }
    }
    if (best > 0) {
      if (colIsAnchor) py = best
      else px = best
      pitchNote =
        bestRel <= 0.15
          ? `（${colIsAnchor ? '行' : '列'}方向按方格假定校正为 ${best.toFixed(2)}）`
          : `（${colIsAnchor ? '行' : '列'}方向取最接近另一轴的候选 ${best.toFixed(2)}，` +
            `但偏差仍有 ${(bestRel * 100).toFixed(0)}%，建议用「按标注格数校准」确认）`
    }
  }
  const colPitch = { pitch: px, strength: colRaw.strength }
  const rowPitch = { pitch: py, strength: rowRaw.strength }

  const colFit = fitLines(colProf, colPitch.pitch, stats(colProf))
  const rowFit = fitLines(rowProf, rowPitch.pitch, stats(rowProf))

  const border = borderUniformity(img)
  const pageBg = border.color

  // 每个方向单独兜底：拟合失败但周期可信时，用「周期 + 最佳相位」
  let bX = 0
  let aX = 0
  if (colFit) {
    bX = colFit.b
    aX = colFit.a
  } else if (colPitch.pitch >= MIN_PITCH) {
    bX = colPitch.pitch
    aX = bestPhase(colProf, bX)
  }
  let bY = 0
  let aY = 0
  if (rowFit) {
    bY = rowFit.b
    aY = rowFit.a
  } else if (rowPitch.pitch >= MIN_PITCH) {
    bY = rowPitch.pitch
    aY = bestPhase(rowProf, bY)
  }
  if (bX <= 0 && bY > 0) {
    bX = bY
    aX = colPitch.pitch >= MIN_PITCH ? bestPhase(colProf, bX) : 0
  }
  if (bY <= 0 && bX > 0) {
    bY = bX
    aY = rowPitch.pitch >= MIN_PITCH ? bestPhase(rowProf, bY) : 0
  }

  let grid: GridSpec | null = null
  let extentMode = ''
  let contentInfo = '未计算'

  if (bX > 0 && bY > 0 && border.uniform) {
    const ext = contentExtent(img, aX, bX, aY, bY, pageBg)
    if (ext) {
      grid = {
        offsetX: aX + bX * ext.minC,
        offsetY: aY + bY * ext.minR,
        cellW: bX,
        cellH: bY,
        cols: ext.maxC - ext.minC + 1,
        rows: ext.maxR - ext.minR + 1,
      }
      extentMode = '内容包围盒'
      contentInfo = `列${ext.minC}..${ext.maxC} 行${ext.minR}..${ext.maxR} 共${ext.count}格`
    } else {
      contentInfo = '包围盒无效'
    }
  } else if (bX <= 0 || bY <= 0) {
    contentInfo = '未识别出周期'
  } else {
    contentInfo = '四周无留白，改用格线区段'
  }

  if (!grid && bX > 0 && bY > 0) {
    // 没有留白边距：用格线的最长连续区段定范围
    const colRun = colFit ? dominantLineRun(collectKs(colProf, aX, bX)) : null
    const rowRun = rowFit ? dominantLineRun(collectKs(rowProf, aY, bY)) : null
    let offsetX = colRun ? aX + bX * colRun.start : aX
    let cols = colRun ? colRun.end - colRun.start : Math.max(1, Math.round(W / bX))
    let offsetY = rowRun ? aY + bY * rowRun.start : aY
    let rows = rowRun ? rowRun.end - rowRun.start : Math.max(1, Math.round(H / bY))
    if (!colRun || cols < 2) {
      offsetX = aX
      cols = Math.max(1, Math.round(W / bX))
    }
    if (!rowRun || rows < 2) {
      offsetY = aY
      rows = Math.max(1, Math.round(H / bY))
    }
    grid = { offsetX, offsetY, cellW: bX, cellH: bY, cols, rows }
    extentMode = '格线区段'
  }

  if (!grid && bX > 0 && bY > 0) {
    const g = gridFromPeriods(img, bX, aX, bY, aY, pageBg)
    if (g) {
      grid = g
      extentMode = '周期+内容包围盒'
    }
  }

  if (!grid) {
    const b = Math.max(MIN_PITCH, Math.round(Math.min(W, H) / 32))
    grid = {
      offsetX: 0,
      offsetY: 0,
      cellW: b,
      cellH: b,
      cols: Math.max(1, Math.round(W / b)),
      rows: Math.max(1, Math.round(H / b)),
    }
    extentMode = '均分兜底'
  }

  grid.cols = Math.max(1, Math.min(grid.cols, 600))
  grid.rows = Math.max(1, Math.min(grid.rows, 600))

  const lines = gridLines(grid)
  const confidence = Math.max(
    0,
    Math.min(
      1,
      (colPitch.strength * (colFit ? 1 : 0.4) + rowPitch.strength * (rowFit ? 1 : 0.4)) / 2,
    ),
  )

  return {
    grid,
    confidence,
    lineXs: lines.xs,
    lineYs: lines.ys,
    debug:
      `剖面=${profileMode} ` +
      `列：自相关${colRaw.pitch.toFixed(2)}→定周期${colPitch.pitch.toFixed(2)}` +
      `(相关${colPitch.strength.toFixed(2)}${colFit ? ` 拟合${colFit.b.toFixed(3)}/${colFit.count}条` : ' 未拟合'}) ` +
      `行：自相关${rowRaw.pitch.toFixed(2)}→定周期${rowPitch.pitch.toFixed(2)}` +
      `(相关${rowPitch.strength.toFixed(2)}${rowFit ? ` 拟合${rowFit.b.toFixed(3)}/${rowFit.count}条` : ' 未拟合'}) ` +
      `相位=${aX.toFixed(2)},${aY.toFixed(2)} 有留白=${border.uniform} ` +
      `背景=RGB(${border.color.join(',')}) 范围来源=${extentMode} ${contentInfo}${pitchNote}`,
  }
}

/** 诊断用：把各剖面导出来看（只在 tools/verify.ts、tools/probe.mjs 里使用） */
export function debugProfiles(img: ImageData): {
  runCol: Float64Array
  runRow: Float64Array
  stepCol: Float64Array
  stepRow: Float64Array
  lum: Float32Array
  width: number
} {
  const lum = buildLuminance(img)
  const run = buildRunProfiles(lum, img.width, img.height)
  const step = buildStepProfiles(lum, img.width, img.height)
  return {
    runCol: run.col,
    runRow: run.row,
    stepCol: step.col,
    stepRow: step.row,
    lum,
    width: img.width,
  }
}

export function gridLines(grid: GridSpec): { xs: number[]; ys: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i <= grid.cols; i++) xs.push(grid.offsetX + i * grid.cellW)
  for (let i = 0; i <= grid.rows; i++) ys.push(grid.offsetY + i * grid.cellH)
  return { xs, ys }
}

export function gridCellCount(grid: GridSpec): number {
  return Math.max(0, grid.cols) * Math.max(0, grid.rows)
}

export function clampGrid(grid: GridSpec, imageW: number, imageH: number): GridSpec {
  const cellW = Math.max(1.2, grid.cellW)
  const cellH = Math.max(1.2, grid.cellH)
  const maxCols = Math.max(1, Math.floor((imageW - grid.offsetX) / cellW) + 1)
  const maxRows = Math.max(1, Math.floor((imageH - grid.offsetY) / cellH) + 1)
  return {
    offsetX: grid.offsetX,
    offsetY: grid.offsetY,
    cellW,
    cellH,
    cols: Math.max(1, Math.min(Math.round(grid.cols), Math.min(maxCols, 600))),
    rows: Math.max(1, Math.min(Math.round(grid.rows), Math.min(maxRows, 600))),
  }
}

/**
 * 估计「纸面/页面背景色」：优先取网格之外的边缘区域，
 * 没有边距时退回图像最外圈像素。取出现次数最多的量化颜色。
 */
export function estimatePageBackground(img: ImageData, grid?: GridSpec): RGB {
  const { width: W, height: H, data } = img
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()

  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const p = (y * W + x) * 4
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const cur = buckets.get(key)
    if (cur) {
      cur.n++
      cur.r += r
      cur.g += g
      cur.b += b
    } else {
      buckets.set(key, { n: 1, r, g, b })
    }
  }

  const hasMargin =
    grid &&
    (grid.offsetX > 4 ||
      grid.offsetY > 4 ||
      grid.offsetX + grid.cols * grid.cellW < W - 4 ||
      grid.offsetY + grid.rows * grid.cellH < H - 4)

  if (grid && hasMargin) {
    const inset = 3
    const x0 = Math.max(0, Math.floor(grid.offsetX) - inset)
    const y0 = Math.max(0, Math.floor(grid.offsetY) - inset)
    const x1 = Math.min(W - 1, Math.ceil(grid.offsetX + grid.cols * grid.cellW) + inset)
    const y1 = Math.min(H - 1, Math.ceil(grid.offsetY + grid.rows * grid.cellH) + inset)
    for (let x = x0; x <= x1; x++) {
      push(x, y0)
      push(x, y0 + 1)
      push(x, y1)
      push(x, y1 - 1)
    }
    for (let y = y0; y <= y1; y++) {
      push(x0, y)
      push(x0 + 1, y)
      push(x1, y)
      push(x1 - 1, y)
    }
  } else {
    const band = Math.max(1, Math.round(Math.min(W, H) * 0.01))
    for (let x = 0; x < W; x++) {
      for (let d = 0; d < band; d++) {
        push(x, d)
        push(x, H - 1 - d)
      }
    }
    for (let y = 0; y < H; y++) {
      for (let d = 0; d < band; d++) {
        push(d, y)
        push(W - 1 - d, y)
      }
    }
  }

  let best: { n: number; r: number; g: number; b: number } | null = null
  for (const v of buckets.values()) {
    if (!best || v.n > best.n) best = v
  }
  if (!best) return [255, 255, 255]
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)]
}
