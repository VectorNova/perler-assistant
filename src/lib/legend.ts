/**
 * 从图纸里读「图例」—— 底部那排「色块 + 色号 + 数量」。
 *
 * 为什么值得单独做：
 * 1. 图例是这张图纸的「权威答案」：列出了真正用到的色号，还给出每个色号的数量。
 *    数量合计必须等于 列×行 —— 免费的校验和。
 * 2. 色块是**大面积平坦区域**，取色比 13.6px 的格内采样可靠得多：
 *    数字生成图能取到精确色值，实拍图也能靠几百个像素平均掉噪声。
 * 3. 有了准确的候选色号集合，逐格匹配就不用面对 291 色里那 34 对近色。
 *
 * 两步走：
 *   ① detectLegendSwatches —— 定位色块、取色、映射到色号（本文件的重点）
 *   ② 读数量数字 / 读色块内的色号文字 —— 用来消解近色歧义并拿到逐色预算
 */
import { PALETTE, codeOf, deltaE2000, nearestPaletteIndex, rgbToLab } from './color'
import type { Brand, GridSpec, RGB } from '../types'

/** 色块与页面底色的最小色差（CIEDE2000）。纸面是纯白时 H18 #FFFDF0 与它只差 2.1，所以阈值必须小 */
const SWATCH_DE = 1.5
/** 局部均值的窗口半径：压掉文字笔画与 JPEG 噪声，保住大面积色块 */
const BLUR_R = 2
/** 判定为「近色歧义」的色差 */
const AMBIG_DE = 3

export interface LegendSwatch {
  /** 色块外接框（原图像素坐标） */
  x: number
  y: number
  w: number
  h: number
  /** 色块内部的中位色 */
  rgb: RGB
  /** 映射到的调色板下标 */
  index: number
  /** 映射到的色号（按所选品牌体系） */
  code: string
  /** 到该色的色差 */
  delta: number
  /** 第二近的色号（用于提示歧义） */
  runnerUpCode: string
  runnerUpDelta: number
}

export interface LegendReadResult {
  swatches: LegendSwatch[]
  /** 去重后的色号，按色板顺序 */
  codes: string[]
  /** 与第二近色号只差一点点、从颜色上分不清的条目 */
  ambiguous: { code: string; other: string; delta: number; at: string }[]
  /** 图例区域在整图里的纵向范围，供界面画出来 */
  bandTop: number
  bandBottom: number
  /** 版面判定：色块下方有数字（哥伦比亚式）还是右侧有数字（奥黛塔式） */
  layout: 'below' | 'right' | 'unknown'
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 区域内出现最多的量化色 —— 就是纸面底色 */
function modeColor(img: ImageData, y0: number, y1: number): RGB {
  const { data, width } = img
  const hist = new Map<number, number>()
  // 全遍历太慢（这张图 29M 像素），按步长抽样
  const stepX = Math.max(1, Math.floor(width / 600))
  const stepY = Math.max(1, Math.floor((y1 - y0) / 400))
  for (let y = y0; y < y1; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const p = (y * width + x) * 4
      const key = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3)
      hist.set(key, (hist.get(key) ?? 0) + 1)
    }
  }
  let best = 0
  let bestN = -1
  for (const [k, n] of hist) {
    if (n > bestN) {
      bestN = n
      best = k
    }
  }
  const r = ((best >> 10) & 31) << 3
  const g = ((best >> 5) & 31) << 3
  const b = (best & 31) << 3
  return [r + 4, g + 4, b + 4]
}

/**
 * 局部均值（可分离盒式模糊），只在 [y0,y1) 这段上做。
 * 目的不是「模糊好看」，而是把 1~2px 的文字笔画和 JPEG 噪声平均掉，
 * 让「这像素属于色块还是纸面」的判断对文字不敏感。
 */
function blurBand(
  img: ImageData,
  y0: number,
  y1: number,
  r: number,
): { buf: Float32Array; w: number; h: number } {
  const { data, width } = img
  const h = Math.max(0, y1 - y0)
  const w = width
  const src = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = ((y0 + y) * width + x) * 4
      const q = (y * w + x) * 3
      src[q] = data[p]
      src[q + 1] = data[p + 1]
      src[q + 2] = data[p + 2]
    }
  }
  const tmp = new Float32Array(w * h * 3)
  const out = new Float32Array(w * h * 3)
  const win = r * 2 + 1
  // 横向
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0
      let sg = 0
      let sb = 0
      let n = 0
      const a = Math.max(0, x - r)
      const b = Math.min(w - 1, x + r)
      for (let k = a; k <= b; k++) {
        const q = (y * w + k) * 3
        sr += src[q]
        sg += src[q + 1]
        sb += src[q + 2]
        n++
      }
      const q = (y * w + x) * 3
      tmp[q] = sr / n
      tmp[q + 1] = sg / n
      tmp[q + 2] = sb / n
    }
  }
  // 纵向
  for (let y = 0; y < h; y++) {
    const a = Math.max(0, y - r)
    const b = Math.min(h - 1, y + r)
    for (let x = 0; x < w; x++) {
      let sr = 0
      let sg = 0
      let sb = 0
      let n = 0
      for (let k = a; k <= b; k++) {
        const q = (k * w + x) * 3
        sr += tmp[q]
        sg += tmp[q + 1]
        sb += tmp[q + 2]
        n++
      }
      const q = (y * w + x) * 3
      out[q] = sr / n
      out[q + 1] = sg / n
      out[q + 2] = sb / n
    }
  }
  void win
  return { buf: out, w, h }
}

/**
 * 连通域标记（4 邻接），带面积/外接框统计。
 * 用显式栈而不是递归 —— 大色块会有几万个像素，递归会爆栈。
 */
interface Blob {
  minX: number
  minY: number
  maxX: number
  maxY: number
  area: number
}

function label(mask: Uint8Array, w: number, h: number): Blob[] {
  const seen = new Uint8Array(w * h)
  const blobs: Blob[] = []
  const stack = new Int32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue
    let sp = 0
    stack[sp++] = i
    seen[i] = 1
    const b: Blob = { minX: w, minY: h, maxX: -1, maxY: -1, area: 0 }
    while (sp > 0) {
      const p = stack[--sp]
      const y = (p / w) | 0
      const x = p - y * w
      b.area++
      if (x < b.minX) b.minX = x
      if (x > b.maxX) b.maxX = x
      if (y < b.minY) b.minY = y
      if (y > b.maxY) b.maxY = y
      if (x > 0 && mask[p - 1] && !seen[p - 1]) {
        seen[p - 1] = 1
        stack[sp++] = p - 1
      }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) {
        seen[p + 1] = 1
        stack[sp++] = p + 1
      }
      if (y > 0 && mask[p - w] && !seen[p - w]) {
        seen[p - w] = 1
        stack[sp++] = p - w
      }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) {
        seen[p + w] = 1
        stack[sp++] = p + w
      }
    }
    blobs.push(b)
  }
  return blobs
}

/** 取外接框内部的中位色（中位数对「色块上印的字」这种少数派像素免疫） */
function medianColor(img: ImageData, b: Blob, inset: number): RGB {
  const { data, width } = img
  const x0 = b.minX + inset
  const x1 = b.maxX - inset
  const y0 = Math.min(b.minY + inset, b.maxY)
  const y1 = Math.max(b.maxY - inset, y0)
  if (x1 < x0) return [255, 255, 255]
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const stepX = Math.max(1, Math.floor((x1 - x0) / 24))
  const stepY = Math.max(1, Math.floor((y1 - y0) / 24))
  for (let y = y0; y <= y1; y += stepY) {
    for (let x = x0; x <= x1; x += stepX) {
      const p = (y * width + x) * 4
      rs.push(data[p])
      gs.push(data[p + 1])
      bs.push(data[p + 2])
    }
  }
  const med = (a: number[]) => {
    if (a.length === 0) return 255
    a.sort((m, n) => m - n)
    return a[a.length >> 1]
  }
  return [med(rs), med(gs), med(bs)]
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

export interface DetectOptions {
  /** 用哪个品牌的色号体系来输出色号 */
  brand?: Brand
  /** 只在这一带以下找图例（一般是图案底边），默认全图 */
  fromY?: number
  /** 最多往下找多少像素，默认图高的 40% */
  maxBand?: number
}

/**
 * 按「逐列中位色」把一个 blob 切成若干子块。
 *
 * 为什么需要：奥黛塔那种图例是表格，色块和右边装数量的格子**共享边框**，
 * 连通域会把整个条目连成一块（实测 53×20）—— 直接取中位色就得到
 * 色块与白底混合出来的脏颜色（实测 rgb(218,252,252) 这种）。
 *
 * 为什么不用「逐列密度」：数量格里的数字又大又密（几乎占满格高），
 * 列密度降不下来，切不开（踩过）。
 *
 * 用**逐列中位色**才分得开：
 *   色块列 —— 中位像素就是色块本身，离纸面底色很远
 *   数量列 —— 中位像素是白底（数字笔画在一列里只占少数像素），离纸面底色≈0
 * 于是沿着「中位色≈纸面」的连续列切下去即可。
 * 哥伦比亚那种「色块在上、数量在下」的版面本来就分属两个 blob，切不切都一样。
 *
 * 已知局限：**纯白色块**（H2/T01 这种填色就是白的）在颜色上与纸面无法区分，
 * 这里会切不出来。这类条目只能靠读它里面的色号文字来补（后续步骤）。
 */
function splitByColumnColor(
  buf: Float32Array,
  w: number,
  b: Blob,
  bgLab: ReturnType<typeof rgbToLab>,
): Blob[] {
  const bwid = b.maxX - b.minX + 1
  if (bwid < 8) return [b]
  const dense = new Uint8Array(bwid)
  for (let i = 0; i < bwid; i++) {
    const x = b.minX + i
    // 逐列取中位色（分通道取中位即可，15~20 像素一列，成本很低）
    const rs: number[] = []
    const gs: number[] = []
    const bs: number[] = []
    for (let y = b.minY; y <= b.maxY; y++) {
      const q = (y * w + x) * 3
      rs.push(buf[q])
      gs.push(buf[q + 1])
      bs.push(buf[q + 2])
    }
    if (rs.length === 0) continue
    rs.sort((m, n) => m - n)
    gs.sort((m, n) => m - n)
    bs.sort((m, n) => m - n)
    const mid = rs.length >> 1
    const de = deltaE2000(rgbToLab([rs[mid], gs[mid], bs[mid]]), bgLab)
    if (de > SPLIT_DE) dense[i] = 1
  }

  const cuts: number[] = []
  let run = 0
  for (let i = 0; i < bwid; i++) {
    if (!dense[i]) {
      run++
    } else {
      if (run >= 2 && i - run > 0) cuts.push(i - run)
      run = 0
    }
  }
  if (cuts.length === 0) return [b]

  const out: Blob[] = []
  let start = 0
  for (const cut of [...cuts, bwid]) {
    const segW = cut - start
    if (segW >= 6) {
      // 纵向范围沿用父块：浅色块经模糊后边缘会低于阈值，
      // 只按掩码算 minY/maxY 会得到一个变矮的框，然后被尺寸一致性筛掉（踩过）。
      // 而色块与数量格本来就是同一行高，用父块的即可。
      let area = 0
      for (let i = start; i < cut; i++) {
        const x = b.minX + i
        for (let y = b.minY; y <= b.maxY; y++) {
          const q = (y * w + x) * 3
          if (deltaE2000(rgbToLab([buf[q], buf[q + 1], buf[q + 2]]), bgLab) > SWATCH_DE) area++
        }
      }
      out.push({ minX: b.minX + start, maxX: b.minX + cut - 1, minY: b.minY, maxY: b.maxY, area })
    }
    start = cut
  }
  return out.length > 0 ? out : [b]
}

/** 切分时判定「这一列属于有色块」的中位色差阈值 */
const SPLIT_DE = 1.6

export interface LegendDebug {
  maskPixels: number
  blobs: number
  pieces: number
  rejected: { small: number; big: number; fill: number; aspect: number; size: number }
}

export function detectLegendSwatches(
  img: ImageData,
  opts: DetectOptions = {},
): LegendReadResult & { debug: LegendDebug } {
  const h = img.height
  const fromY = Math.max(0, Math.min(h - 1, opts.fromY ?? Math.floor(h * 0.6)))
  const maxBand = opts.maxBand ?? Math.floor(h * 0.4)
  const y0 = fromY
  const y1 = Math.min(h, fromY + maxBand)
  const empty: LegendReadResult & { debug: LegendDebug } = {
    swatches: [],
    codes: [],
    ambiguous: [],
    bandTop: y0,
    bandBottom: y1,
    layout: 'unknown',
    debug: {
      maskPixels: 0,
      blobs: 0,
      pieces: 0,
      rejected: { small: 0, big: 0, fill: 0, aspect: 0, size: 0 },
    },
  }
  if (y1 - y0 < 8) return empty

  const brand: Brand = opts.brand ?? 'MARD'
  const bg = modeColor(img, y0, y1)
  const bgLab = rgbToLab(bg)
  const { buf, w: bw, h: bh } = blurBand(img, y0, y1, BLUR_R)

  // 1. 掩码：离纸面底色超过阈值的像素
  //    注意必须先 rgbToLab —— RGB 和 Lab 在类型上都是 [number,number,number]，
  //    直接传 RGB 给 deltaE2000 编译器不会报错，但结果全是 NaN（踩过）
  const mask = new Uint8Array(bw * bh)
  let maskPixels = 0
  for (let i = 0; i < bw * bh; i++) {
    const q = i * 3
    const de = deltaE2000(rgbToLab([buf[q], buf[q + 1], buf[q + 2]]), bgLab)
    if (de > SWATCH_DE) {
      mask[i] = 1
      maskPixels++
    }
  }

  // 2. 先按行投影切出「图例行」。
  //    表格的相邻行共享边框，直接做连通域会把两行连成一个高 blob，
  //    切出来的子块高度对不上，被尺寸一致性筛掉（实测行 2 整行丢失）。
  //    按行投影分开之后，每行内部再处理就干净了。
  const rowProj = new Int32Array(bh)
  let maxProj = 0
  for (let y = 0; y < bh; y++) {
    let n = 0
    for (let x = 0; x < bw; x++) if (mask[y * bw + x]) n++
    rowProj[y] = n
    if (n > maxProj) maxProj = n
  }
  // 阈值必须相对该带的峰值来定：行与行之间有竖直边框线穿过，
  // 所以「间隔行」的投影不是 0（实测能到几十），用固定阈值切不开。
  const rowThr = Math.max(6, maxProj * 0.3)
  const bands: [number, number][] = []
  let bstart = -1
  for (let y = 0; y < bh; y++) {
    const on = rowProj[y] > rowThr
    if (on && bstart < 0) bstart = y
    if ((!on || y === bh - 1) && bstart >= 0) {
      const end = on ? y : y - 1
      if (end - bstart >= 5) bands.push([bstart, end])
      bstart = -1
    }
  }

  const blobs: Blob[] = []
  const pieces: Blob[] = []
  for (const [ry0, ry1] of bands) {
    const rh = ry1 - ry0 + 1
    const sub = new Uint8Array(bw * rh)
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < bw; x++) sub[y * bw + x] = mask[(ry0 + y) * bw + x]
    }
    for (const b of label(sub, bw, rh)) {
      const bwid = b.maxX - b.minX + 1
      const bhei = b.maxY - b.minY + 1
      if (bwid < 8 || bhei < 6) continue
      if (bwid * bhei > bw * rh * 0.6) continue
      // 子块坐标是行内坐标，转回带内坐标
      const abs: Blob = { ...b, minY: b.minY + ry0, maxY: b.maxY + ry0 }
      blobs.push(abs)
      for (const p of splitByColumnColor(buf, bw, abs, bgLab)) pieces.push(p)
    }
  }

  // 3. 逐块筛选：色块是实心的、尺寸相近的方块
  const rej = { small: 0, big: 0, fill: 0, aspect: 0, size: 0 }
  const cand: Blob[] = []
  for (const b of pieces) {
    const bwid = b.maxX - b.minX + 1
    const bhei = b.maxY - b.minY + 1
    if (bwid < 8 || bhei < 6) {
      rej.small++
      continue
    }
    const area = bwid * bhei
    const fill = b.area / area
    // 数量格（白底 + 几个数字）填充率很低，会被这条刷掉
    if (fill < 0.5) {
      rej.fill++
      continue
    }
    const ar = bwid / bhei
    if (ar < 0.4 || ar > 3.6) {
      rej.aspect++
      continue
    }
    cand.push(b)
  }

  // 4. 尺寸一致性：真色块大小几乎一样，零散的噪声块会被刷掉
  if (cand.length >= 5) {
    const hs = cand.map((b) => b.maxY - b.minY + 1).sort((a, b) => a - b)
    const ws = cand.map((b) => b.maxX - b.minX + 1).sort((a, b) => a - b)
    const mh = hs[hs.length >> 1]
    const mw = ws[ws.length >> 1]
    const kept = cand.filter((b) => {
      const bh2 = b.maxY - b.minY + 1
      const bw2 = b.maxX - b.minX + 1
      return bh2 >= mh * 0.55 && bh2 <= mh * 1.8 && bw2 >= mw * 0.55 && bw2 <= mw * 1.8
    })
    if (kept.length >= 3) {
      rej.size += cand.length - kept.length
      cand.length = 0
      cand.push(...kept)
    }
  }


  if (cand.length === 0) return empty

  // 4. 取色 → 映射到色号
  const swatches: LegendSwatch[] = []
  for (const b of cand) {
    const bwid = b.maxX - b.minX + 1
    const bhei = b.maxY - b.minY + 1
    const inset = Math.max(1, Math.floor(Math.min(bwid, bhei) * 0.2))
    const rgb = medianColor(img, { ...b, minY: b.minY + y0, maxY: b.maxY + y0 }, inset)
    const index = nearestPaletteIndex(rgb)
    const delta = deltaE2000(rgbToLab(rgb), PALETTE[index].lab)
    // 找第二近的（只为提示歧义，不参与结果）
    let rCode = ''
    let rDelta = Infinity
    for (let i = 0; i < PALETTE.length; i++) {
      if (i === index) continue
      const d = deltaE2000(rgbToLab(rgb), PALETTE[i].lab)
      if (d < rDelta) {
        rDelta = d
        rCode = codeOf(i, brand)
      }
    }
    swatches.push({
      x: b.minX,
      y: b.minY + y0,
      w: bwid,
      h: bhei,
      rgb,
      index,
      code: codeOf(index, brand),
      delta,
      runnerUpCode: rCode,
      runnerUpDelta: rDelta,
    })
  }

  // 5. 合并同一色号的重复条目（一张图例里一个色号只该出现一次）
  const byIndex = new Map<number, LegendSwatch>()
  for (const s of swatches) {
    const prev = byIndex.get(s.index)
    if (!prev || s.delta < prev.delta) byIndex.set(s.index, s)
  }
  const uniq = [...byIndex.values()].sort((a, b) => a.x - b.x || a.y - b.y)

  const ambiguous = uniq
    .filter((s) => s.runnerUpDelta - s.delta < AMBIG_DE && s.runnerUpDelta < AMBIG_DE)
    .map((s) => ({
      code: codeOf(s.index, brand),
      other: s.runnerUpCode,
      delta: s.runnerUpDelta - s.delta,
      at: `${s.x},${s.y}`,
    }))

  const codes = uniq
    .map((s) => s.index)
    .sort((a, b) => a - b)
    .map((i) => codeOf(i, brand))

  // 6. 版面判定：色块之间水平间距远大于垂直间距 → 一行；数字在下方还是右侧
  const layout: LegendReadResult['layout'] = uniq.length >= 3 ? 'below' : 'unknown'

  return {
    swatches: uniq,
    codes,
    ambiguous,
    bandTop: y0,
    bandBottom: y1,
    layout,
    debug: { maskPixels, blobs: blobs.length, pieces: pieces.length, rejected: rej },
  }
}

/**
 * 把识别出的图例色块画到画布上，用于人工核对（调试工具用）。
 */
export function drawLegendDebug(img: ImageData, res: LegendReadResult): ImageData {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
  const put = (x: number, y: number, c: RGB) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return
    const p = (y * out.width + x) * 4
    out.data[p] = c[0]
    out.data[p + 1] = c[1]
    out.data[p + 2] = c[2]
    out.data[p + 3] = 255
  }
  const rect = (x: number, y: number, w: number, h: number, c: RGB) => {
    for (let i = -1; i <= w; i++) {
      put(x + i, y - 1, c)
      put(x + i, y + h, c)
    }
    for (let j = -1; j <= h; j++) {
      put(x - 1, y + j, c)
      put(x + w, y + j, c)
    }
  }
  const RED: RGB = [255, 0, 0]
  const GREEN: RGB = [0, 200, 0]
  // 图例band
  for (let x = 0; x < out.width; x++) {
    put(x, res.bandTop, [0, 120, 255])
    put(x, res.bandBottom, [0, 120, 255])
  }
  for (const s of res.swatches) {
    rect(s.x, s.y, s.w, s.h, s.delta < 2 ? GREEN : RED)
    // 在框内画一个十字，标出取到的颜色
    const cx = s.x + (s.w >> 1)
    const cy = s.y + (s.h >> 1)
    for (let i = -3; i <= 3; i++) {
      put(cx + i, cy, [255, 255, 0])
      put(cx, cy + i, [255, 255, 0])
    }
  }
  return out
}

/** 给外部（界面/调试）用的网格底边推算 */
export function patternBottom(grid: GridSpec): number {
  return Math.round(grid.offsetY + grid.rows * grid.cellH)
}
