/**
 * 验证脚本：生成多张「仿拼豆图纸」PNG，跑完整识别流程，和 ground truth 对比。
 * 用 esbuild 打包后在 Node 里运行（见 tools/run-verify.mjs）。
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { PALETTE, deltaE2000, rgbToLab } from '../src/lib/color'
import { detectGrid, estimatePageBackground, debugProfiles } from '../src/lib/gridDetect'
import { buildPattern, derivePlan, rawCounts } from '../src/lib/pattern'
import { buildRegions, buildSteps } from '../src/lib/order'
import { PALETTE, codeOf, colorCacheKey, formatColorCode, indicesInSystem, nearestPaletteIndex, resolveColorCodes } from '../src/lib/color'
import { EMPTY, type GridSpec, type Region, type RegionOrderMode } from '../src/types'

/* ----------------------------- PNG 编解码 ----------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1)
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width)
  dv.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 2 // RGB
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw), { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 只支持 8bit、非隔行的灰度/RGB/RGBA */
export function decodePng(buf: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let off = 8
  let width = 0
  let height = 0
  let colorType = 6
  const idat: Uint8Array[] = []
  while (off < buf.length) {
    const len = dv.getUint32(off)
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7])
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8)
      height = dv.getUint32(off + 12)
      colorType = buf[off + 17]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    off += 12 + len
  }
  const all = new Uint8Array(idat.reduce((s, d) => s + d.length, 0))
  let o = 0
  for (const d of idat) {
    all.set(d, o)
    o += d.length
  }
  const raw = new Uint8Array(inflateSync(Buffer.from(all)))
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const stride = width * bpp
  const rgba = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1)
    const filter = raw[base]
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i]
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = x
      if (filter === 1) v = x + a
      else if (filter === 2) v = x + b
      else if (filter === 3) v = x + ((a + b) >> 1)
      else if (filter === 4) v = x + paeth(a, b, c)
      cur[i] = v & 0xff
    }
    for (let x = 0; x < width; x++) {
      const s = x * bpp
      const d = (y * width + x) * 4
      if (colorType === 6) {
        rgba[d] = cur[s]
        rgba[d + 1] = cur[s + 1]
        rgba[d + 2] = cur[s + 2]
        rgba[d + 3] = cur[s + 3]
      } else if (colorType === 2) {
        rgba[d] = cur[s]
        rgba[d + 1] = cur[s + 1]
        rgba[d + 2] = cur[s + 2]
        rgba[d + 3] = 255
      } else {
        rgba[d] = rgba[d + 1] = rgba[d + 2] = cur[s]
        rgba[d + 3] = 255
      }
    }
    prev.set(cur)
  }
  return { width, height, rgba }
}

/* ----------------------------- 绘图工具 ----------------------------- */

class Bmp {
  w: number
  h: number
  px: Uint8Array

  constructor(w: number, h: number, bg: [number, number, number]) {
    this.w = w
    this.h = h
    this.px = new Uint8Array(w * h * 3)
    this.fillRect(0, 0, w, h, bg)
  }

  fillRect(x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) {
    const ax = Math.max(0, Math.round(x0))
    const ay = Math.max(0, Math.round(y0))
    const bx = Math.min(this.w, Math.round(x1))
    const by = Math.min(this.h, Math.round(y1))
    for (let y = ay; y < by; y++) {
      let p = (y * this.w + ax) * 3
      for (let x = ax; x < bx; x++, p += 3) {
        this.px[p] = c[0]
        this.px[p + 1] = c[1]
        this.px[p + 2] = c[2]
      }
    }
  }

  get(x: number, y: number): [number, number, number] {
    const p = (y * this.w + x) * 3
    return [this.px[p], this.px[p + 1], this.px[p + 2]]
  }

  set(x: number, y: number, c: [number, number, number]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const p = (y * this.w + x) * 3
    this.px[p] = c[0]
    this.px[p + 1] = c[1]
    this.px[p + 2] = c[2]
  }

  noise(amount: number, rng: () => number) {
    for (let i = 0; i < this.px.length; i++) {
      const v = this.px[i] + Math.round((rng() * 2 - 1) * amount)
      this.px[i] = v < 0 ? 0 : v > 255 ? 255 : v
    }
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 贪心挑 K 个互相分得很开的调色板颜色，保证测试有意义 */
function pickDistinctColors(k: number, seed: number): number[] {
  const rng = mulberry32(seed)
  const chosen: number[] = [Math.floor(rng() * PALETTE.length)]
  while (chosen.length < k) {
    let best = -1
    let bestScore = -1
    for (let attempt = 0; attempt < 400; attempt++) {
      const cand = Math.floor(rng() * PALETTE.length)
      if (chosen.includes(cand)) continue
      let minD = Infinity
      for (const c of chosen) {
        const a = PALETTE[c].rgb
        const b = PALETTE[cand].rgb
        const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
        if (d < minD) minD = d
      }
      if (minD > bestScore) {
        bestScore = minD
        best = cand
      }
    }
    if (best < 0) break
    chosen.push(best)
  }
  return chosen
}

/** Voronoi 分块，做出连通的色块 */
function buildTruthGrid(rows: number, cols: number, paletteIdx: number[], seed: number): Int16Array {
  const rng = mulberry32(seed)
  const seeds = paletteIdx.map((p) => ({ r: rng() * rows, c: rng() * cols, p }))
  const cells = new Int16Array(rows * cols)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let best = 0
      let bestD = Infinity
      for (let k = 0; k < seeds.length; k++) {
        const d = (seeds[k].r - r) ** 2 + (seeds[k].c - c) ** 2
        if (d < bestD) {
          bestD = d
          best = k
        }
      }
      cells[r * cols + c] = seeds[best].p
    }
  }
  // 加一块大方块，测大面积同色
  const sq = paletteIdx[0]
  for (let r = Math.floor(rows * 0.2); r < Math.floor(rows * 0.55); r++) {
    for (let c = Math.floor(cols * 0.55); c < Math.floor(cols * 0.9); c++) {
      cells[r * cols + c] = sq
    }
  }
  return cells
}

interface CaseSpec {
  name: string
  cols: number
  rows: number
  cell: number
  margin: number
  gridLine: [number, number, number] | null
  lineWidth: number
  codes: boolean
  noise: number
  blankRing: number
  legend: boolean
  pageBg: [number, number, number]
}

interface Case {
  spec: CaseSpec
  truth: Int16Array
  bead: Uint8Array
  png: Uint8Array
  bmp: Bmp
  /** 图纸原点（像素） */
  originX: number
  originY: number
}

function renderCase(spec: CaseSpec, seed: number): Case {
  const paletteIdx = pickDistinctColors(12, seed)
  const truth = buildTruthGrid(spec.rows, spec.cols, paletteIdx, seed + 1)
  const bead = new Uint8Array(spec.rows * spec.cols).fill(1)
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < spec.cols; c++) {
      if (
        r < spec.blankRing ||
        c < spec.blankRing ||
        r >= spec.rows - spec.blankRing ||
        c >= spec.cols - spec.blankRing
      ) {
        bead[r * spec.cols + c] = 0
      }
    }
  }

  const legendH = spec.legend ? 140 : 0
  const W = Math.round(spec.margin * 2 + spec.cols * spec.cell)
  const H = Math.round(spec.margin * 2 + spec.rows * spec.cell) + legendH
  const bmp = new Bmp(W, H, spec.pageBg)

  // 格子填充
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < spec.cols; c++) {
      const x0 = spec.margin + c * spec.cell
      const y0 = spec.margin + r * spec.cell
      const x1 = spec.margin + (c + 1) * spec.cell
      const y1 = spec.margin + (r + 1) * spec.cell
      if (!bead[r * spec.cols + c]) continue
      const rgb = PALETTE[truth[r * spec.cols + c]].rgb
      bmp.fillRect(x0, y0, x1, y1, [rgb[0], rgb[1], rgb[2]])
    }
  }

  // 网格线
  if (spec.gridLine) {
    const lw = spec.lineWidth
    for (let c = 0; c <= spec.cols; c++) {
      const x = spec.margin + c * spec.cell
      bmp.fillRect(x, spec.margin, x + lw, spec.margin + spec.rows * spec.cell, spec.gridLine)
    }
    for (let r = 0; r <= spec.rows; r++) {
      const y = spec.margin + r * spec.cell
      bmp.fillRect(spec.margin, y, spec.margin + spec.cols * spec.cell, y + lw, spec.gridLine)
    }
  }

  // 模拟格内色号文字：几条深色小横线，占格子约 15% 面积
  if (spec.codes) {
    const dark: [number, number, number] = [40, 40, 40]
    for (let r = 0; r < spec.rows; r++) {
      for (let c = 0; c < spec.cols; c++) {
        if (!bead[r * spec.cols + c]) continue
        const x0 = spec.margin + c * spec.cell
        const y0 = spec.margin + r * spec.cell
        const bw = spec.cell * 0.42
        const bars = 2
        for (let b = 0; b < bars; b++) {
          const by = y0 + spec.cell * (0.34 + b * 0.22)
          bmp.fillRect(x0 + spec.cell * 0.29, by, x0 + spec.cell * 0.29 + bw, by + Math.max(1, spec.cell * 0.09), dark)
        }
      }
    }
  }

  // 图例表格（测「不要把图例算进图纸范围」）
  if (spec.legend) {
    const ly = H - legendH + 16
    for (let i = 0; i <= 4; i++) {
      bmp.fillRect(spec.margin, ly + i * 24, Math.min(W - spec.margin, spec.margin + 380), ly + i * 24 + 1, [150, 150, 150])
    }
    for (let i = 0; i <= 4; i++) {
      bmp.fillRect(spec.margin + i * 95, ly, spec.margin + i * 95 + 1, ly + 96, [150, 150, 150])
    }
  }

  if (spec.noise > 0) bmp.noise(spec.noise, mulberry32(seed + 7))

  const png = encodePng(W, H, bmp.px)
  return { spec, truth, bead, png, bmp, originX: spec.margin, originY: spec.margin }
}

/* ----------------------------- 校验 ----------------------------- */

function toImageData(c: Case): ImageData {
  const { width, height, rgba } = decodePng(c.png)
  return { width, height, data: rgba, colorSpace: 'srgb' } as unknown as ImageData
}

function truthPaletteIndices(c: Case): Int16Array {
  return c.truth
}

/** 期望的「内容包围盒」网格：只有真的放豆子的格子才算内容 */
function expectedContentExtent(c: Case) {
  const spec = c.spec
  let minR = Infinity
  let minC = Infinity
  let maxR = -1
  let maxC = -1
  for (let r = 0; r < spec.rows; r++) {
    for (let col = 0; col < spec.cols; col++) {
      if (!c.bead[r * spec.cols + col]) continue
      if (r < minR) minR = r
      if (r > maxR) maxR = r
      if (col < minC) minC = col
      if (col > maxC) maxC = col
    }
  }
  return {
    minR,
    minC,
    maxR,
    maxC,
    cols: maxC - minC + 1,
    rows: maxR - minR + 1,
    offsetX: c.originX + minC * spec.cell,
    offsetY: c.originY + minR * spec.cell,
  }
}

interface Report {
  name: string
  ok: boolean
  lines: string[]
}

function verifyCase(c: Case): Report {
  const img = toImageData(c)
  const lines: string[] = []
  const spec = c.spec

  const det = detectGrid(img)
  const g: GridSpec = det.grid
  const exp = expectedContentExtent(c)
  lines.push(
    `自动识别：格距 ${g.cellW.toFixed(2)}×${g.cellH.toFixed(2)} (真值 ${spec.cell})，` +
      `原点 ${g.offsetX.toFixed(1)},${g.offsetY.toFixed(1)} (期望 ${exp.offsetX},${exp.offsetY})，` +
      `${g.cols}×${g.rows} (期望 ${exp.cols}×${exp.rows})，` +
      `置信度 ${(det.confidence * 100).toFixed(0)}%`,
  )
  if (det.debug) lines.push(`诊断：${det.debug}`)

  if (process.env.DUMP === spec.name.slice(0, 1)) {
    const prof = debugProfiles(img)
    const top = (arr: Float64Array, k: number) => {
      const idx = Array.from(arr.keys())
      idx.sort((a, b) => arr[b] - arr[a])
      return idx
        .slice(0, k)
        .map((i) => `${i}:${arr[i].toFixed(3)}`)
        .join('  ')
    }
    lines.push(`  剖面 runRow 前20 → ${top(prof.runRow, 20)}`)
    lines.push(`  剖面 stepRow 前20 → ${top(prof.stepRow, 20)}`)
    lines.push(
      `  真值横线位置 → ${Array.from({ length: spec.rows + 1 }, (_, i) => Math.round(c.originY + i * spec.cell))
        .slice(0, 34)
        .join(',')}`,
    )
    // 真值横线处的剖面值
    const vals = Array.from({ length: spec.rows + 1 }, (_, i) => {
      const y = Math.round(c.originY + i * spec.cell)
      return prof.runRow[y] ?? 0
    })
    lines.push(`  真值横线处的 runRow 值 → ${vals.map((v) => v.toFixed(2)).join(',')}`)

    const L = (x: number, y: number) => prof.lum[y * prof.width + x].toFixed(0)
    for (let y = 24; y <= 34; y++) {
      lines.push(
        `  探针 y=${y} runRow=${(prof.runRow[y] ?? 0).toFixed(3)} lum@100/300/500/700 = ` +
          `${L(100, y)},${L(300, y)},${L(500, y)},${L(700, y)}`,
      )
    }
  }

  // 用真值网格来评估「颜色识别」本身的能力（隔离网格误差）
  const truthGrid: GridSpec = {
    offsetX: c.originX,
    offsetY: c.originY,
    cellW: spec.cell,
    cellH: spec.cell,
    cols: spec.cols,
    rows: spec.rows,
  }
  const pageBg = estimatePageBackground(img, truthGrid)
  const built = buildPattern(img, truthGrid, {
    name: spec.name,
    imageUrl: '',
    imageHash: 'test',
    pageBg,
    dropBackground: true,
  })

  const truth = truthPaletteIndices(c)
  let colorWrong = 0
  let blankWrong = 0
  let blankExpected = 0
  let blankUnexpected = 0
  let beadTotal = 0
  const bgLab = rgbToLab(built.pageBg)
  const wrongColors = new Map<number, number>()
  for (let i = 0; i < truth.length; i++) {
    const expectBead = c.bead[i] === 1
    const gotBead = built.pattern.blank[i] === 0 && built.pattern.cells[i] !== EMPTY
    if (expectBead) beadTotal++
    if (expectBead !== gotBead) {
      blankWrong++
      // 「颜色几乎等于纸面背景、且贴边」的豆子被判成空格是设计内的行为
      // （用户可以在界面里关掉这个判断），只有其它误判才算错。
      const nearBg = deltaE2000(rgbToLab(PALETTE[truth[i]].rgb), bgLab) <= 8
      if (nearBg) blankExpected++
      else {
        blankUnexpected++
        wrongColors.set(truth[i], (wrongColors.get(truth[i]) ?? 0) + 1)
      }
      continue
    }
    if (expectBead && built.pattern.cells[i] !== truth[i]) colorWrong++
  }
  const colorAcc = beadTotal > 0 ? (1 - colorWrong / beadTotal) * 100 : 100

  lines.push(
    `颜色识别（用真值网格）：豆子 ${beadTotal} 粒，错色 ${colorWrong} 格，准确率 ${colorAcc.toFixed(2)}%`,
  )
  lines.push(
    `  空格判定：与背景几乎同色而贴边（预期行为）${blankExpected} 格，其它误判 ${blankUnexpected} 格`,
  )
  if (blankUnexpected > 0) {
    const desc = [...wrongColors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([idx, n]) => `${PALETTE[idx].keys.MARD}(${PALETTE[idx].hex})×${n}`)
      .join(' ')
    lines.push(`  误判颜色：${desc}`)
  }
  lines.push(`页面背景估计 RGB(${pageBg.join(',')})，真值 RGB(${spec.pageBg.join(',')})`)

  // 再用「自动识别的网格」跑一遍，看端到端效果
  const endToEnd = buildPattern(img, g, {
    name: spec.name,
    imageUrl: '',
    imageHash: 'test',
    pageBg,
    dropBackground: true,
  })
  const counts = rawCounts(endToEnd.pattern)
  const plan = derivePlan(endToEnd.pattern, new Set())
  const steps = buildSteps(plan, g, { colorOrder: 'countDesc', cellOrder: 'blob' }, 'MARD')
  lines.push(
    `端到端（自动网格）：${g.cols}×${g.rows} 格，识别出 ${counts.size} 种颜色、${plan.total} 粒，` +
      `拆成 ${steps.length} 个颜色步骤`,
  )
  const firstStep = steps[0]
  if (firstStep) {
    lines.push(
      `第一步：色号 ${firstStep.key}，${firstStep.count} 粒，` +
        `首粒在第 ${Math.floor(firstStep.cells[0] / g.cols) + 1} 行第 ${(firstStep.cells[0] % g.cols) + 1} 列`,
    )
  }

  const pitchOk = Math.abs(g.cellW - spec.cell) < 0.35 && Math.abs(g.cellH - spec.cell) < 0.35
  const dimOk = g.cols === exp.cols && g.rows === exp.rows
  const originOk = Math.abs(g.offsetX - exp.offsetX) < 1.3 && Math.abs(g.offsetY - exp.offsetY) < 1.3
  const ok = colorAcc > 99.5 && blankUnexpected === 0 && dimOk && pitchOk && originOk
  lines.push(
    `判定：格距 ${pitchOk ? 'OK' : '偏差过大'} · 尺寸 ${dimOk ? 'OK' : '不符'} · ` +
      `原点 ${originOk ? 'OK' : '偏移'} · 颜色 ${colorAcc > 99.5 ? 'OK' : '有偏差'} · ` +
      `空格 ${blankUnexpected === 0 ? 'OK' : `${blankUnexpected} 格误判`}`,
  )

  return { name: spec.name, ok, lines }
}

/* ----------------------------- 色板约束校验 ----------------------------- */

/**
 * 「给了图例就绝不能出现图例外的颜色」的回归测试。
 *
 * 用户报过：上传 MARD 图纸后识别出 P1、R8，而原图里根本没有这两个色号。
 * 查下来是 buildPattern 里「超出容差就回退到全色板」那条路径凭空造出来的
 * （R08 在色板里没有 ΔE<3 的近色，所以不可能是近色翻转）。
 * 这里用一个极端的 allowed（只给一个很暗的颜色）把行为钉死：
 *  - 关掉 allowForeignColors：所有格子只能落到那一个色号上
 *  - 打开 allowForeignColors：会出现图例之外的颜色，且 foreign 计数 > 0
 */
function verifyStrictPalette(c: Case, spec: CaseSpec): Report {
  const img = toImageData(c)
  const grid: GridSpec = {
    offsetX: c.originX,
    offsetY: c.originY,
    cellW: spec.cell,
    cellH: spec.cell,
    cols: spec.cols,
    rows: spec.rows,
  }

  // 找一个「很暗」的色号当唯一的图例色 —— 和图纸里大部分浅色都差得很远，
  // 保证一定有格子超出容差，从而真的走到那条分支
  let darkIdx = 0
  let darkLum = Infinity
  PALETTE.forEach((p, i) => {
    const lum = 0.299 * p.rgb[0] + 0.587 * p.rgb[1] + 0.114 * p.rgb[2]
    if (lum < darkLum) {
      darkLum = lum
      darkIdx = i
    }
  })
  const allowed = [darkIdx]
  const code = PALETTE[darkIdx].keys.MARD

  const base = {
    name: 'strict',
    imageUrl: '',
    imageHash: 'strict',
    dropBackground: false,
    allowed,
  }
  const strict = buildPattern(img, grid, { ...base, allowForeignColors: false })
  const loose = buildPattern(img, grid, { ...base, allowForeignColors: true })

  const distinct = (p: { cells: Int16Array }) => {
    const s = new Set<number>()
    for (let i = 0; i < p.cells.length; i++) {
      if (p.cells[i] !== EMPTY) s.add(p.cells[i])
    }
    return s
  }

  const strictSet = distinct(strict.pattern)
  const looseSet = distinct(loose.pattern)
  const strictOk = strictSet.size === 1 && strictSet.has(darkIdx)
  const looseOk = loose.foreign > 0 && looseSet.size > 1
  const strictNoForeign = strictSet.size === 1 && strict.foreign === 0

  const lines = [
    `唯一图例色号：${code} ${PALETTE[darkIdx].hex}（亮度最低的一个）`,
    '',
    `  关闭 allowForeignColors：出现 ${strictSet.size} 种颜色，foreign=${strict.foreign}，unmatched=${strict.unmatched}`,
    `  打开 allowForeignColors：出现 ${looseSet.size} 种颜色，foreign=${loose.foreign}`,
    '',
    `判定：严格模式只出现图例里的颜色 ${strictOk ? 'OK' : '不达标'}` +
      ` · 严格模式没有图例外的颜色 ${strictNoForeign ? 'OK' : '不达标'}` +
      ` · 逃生开关确实会引入图例外的颜色 ${looseOk ? 'OK' : '不达标'}`,
  ]

  return {
    name: '色板约束：给了图例就不出现图例外的颜色',
    ok: strictOk && strictNoForeign && looseOk,
    lines,
  }
}

/* ----------------------------- 颜色缓存键校验 ----------------------------- */

/**
 * 「不同颜色绝不能共用缓存键」的回归测试。
 *
 * 背景：颜色匹配结果按 RGB 缓存。原来 color.ts 用 5 位/通道、pattern.ts 用
 * 6 位/通道分桶，桶内所有颜色共用首次算出的答案。实测色板里
 * G15 #FCF9E0 与 H21 #FFFBE1 的 6 位键完全相同（(63,62,56)），
 * 于是「同一张图、格子的处理顺序不同、结果不同」—— 先遇到谁整桶就都算谁。
 * 这是**可复现性**问题：留着它，后面所有调试结论都不可信。
 *
 * 用完整 24 位键之后不同颜色必然落在不同键上，顺序无关性由结构保证。
 * 这条断言把「键必须单射」钉死，防止有人为了性能再改回量化。
 */
function verifyColorCacheKey(): Report {
  const byKey = new Map<number, number[]>()
  PALETTE.forEach((p, i) => {
    const k = colorCacheKey(p.rgb)
    const a = byKey.get(k)
    if (a) a.push(i)
    else byKey.set(k, [i])
  })
  const collisions: number[][] = []
  for (const g of byKey.values()) if (g.length > 1) collisions.push(g)

  const norm = (s: string) => s.replace(/^([A-Z]+)0*(\d+)$/, '$1$2')
  const idxOf = (code: string) => PALETTE.findIndex((p) => norm(p.keys.MARD ?? '') === code)
  const g15 = idxOf('G15')
  const h21 = idxOf('H21')
  const separated =
    g15 >= 0 && h21 >= 0 && colorCacheKey(PALETTE[g15].rgb) !== colorCacheKey(PALETTE[h21].rgb)

  let selfHit = 0
  for (let i = 0; i < PALETTE.length; i++) {
    if (nearestPaletteIndex(PALETTE[i].rgb) === i) selfHit++
  }

  const checks: [string, boolean, string][] = [
    [
      '不同颜色不共用缓存键',
      collisions.length === 0,
      collisions.length === 0
        ? `${PALETTE.length} 个颜色键全部唯一`
        : `撞车 ${collisions.length} 组：${collisions.map((g) => g.map((i) => PALETTE[i].hex).join('/')).join(' ')}`,
    ],
    ['G15 与 H21 已分开（曾经同桶）', separated, `G15=${PALETTE[g15]?.hex} H21=${PALETTE[h21]?.hex}`],
    ['每个色板颜色都能精确命中自己', selfHit === PALETTE.length, `${selfHit}/${PALETTE.length}`],
  ]

  return {
    name: '颜色缓存：不同颜色不共用键（结果与处理顺序无关）',
    ok: checks.every(([, ok]) => ok),
    lines: checks.map(([n, ok, d]) => `  ${ok ? '✓' : '✗'} ${n} — ${d}`),
  }
}

/* ----------------------------- 色号体系校验 ----------------------------- */

/**
 * 「选了 MARD 221 就绝不可能识别出 P/Q/R/T/Y/ZG」的回归测试。
 *
 * 背景：用户报「上传 MARD 图纸后识别出原图没有的 P1、R8」，且这两个色号原图里确实没有。
 * 查证后确认 MARD 有两套体系：
 *   221 色 = A–H(26/32/29/26/24/25/21/23) + M(15)
 *   291 色 = 221 + P(23) Q(5) R(28) T(1) Y(5) ZG(8)，共多 70 个
 * 数据源 github.com/HansBug/pindou-color-data；已验证 221 ⊂ 291 且共享色号 HEX 完全一致。
 *
 * 我们的色板是 291，用户的图纸是 221。没有「体系」这个概念时，匹配不上就会落到那 70 个
 * **在图纸里根本不存在**的色号上 —— 这是数据问题，不是算法问题。
 */
function verifyPaletteSystem(c: Case, spec: CaseSpec): Report {
  const img = toImageData(c)
  const grid: GridSpec = {
    offsetX: c.originX,
    offsetY: c.originY,
    cellW: spec.cell,
    cellH: spec.cell,
    cols: spec.cols,
    rows: spec.rows,
  }
  const i221 = indicesInSystem('MARD221')
  const i291 = indicesInSystem('MARD291')
  const set221 = new Set(i221)
  const norm = (s: string) => s.replace(/^([A-Z]+)0*(\d+)$/, '$1$2')
  const idxOf = (code: string) => PALETTE.findIndex((p) => norm(p.keys.MARD ?? '') === code)
  const mag = idxOf('P1')
  const ran = idxOf('R8')

  // 用 221 当候选集识别 —— 等价于「不粘图例时的默认行为」
  const res = buildPattern(img, grid, {
    name: 'sys',
    imageUrl: '',
    imageHash: 'sys',
    dropBackground: false,
    allowed: i221,
  })
  const used = new Set<number>()
  for (let i = 0; i < res.pattern.cells.length; i++) {
    const v = res.pattern.cells[i]
    if (v !== EMPTY) used.add(v)
  }
  const outside = [...used].filter((v) => !set221.has(v)).map((v) => norm(PALETTE[v].keys.MARD ?? ''))

  const checks: [string, boolean, string][] = [
    ['221 体系恰为 221 色', i221.length === 221, `${i221.length} 色`],
    ['291 体系恰为 291 色', i291.length === 291, `${i291.length} 色`],
    ['P1 被排除在 221 之外', mag >= 0 && !set221.has(mag), mag >= 0 ? '色板里有 P01，已排除' : '色板里没有'],
    ['R8 被排除在 221 之外', ran >= 0 && !set221.has(ran), ran >= 0 ? '色板里有 R08，已排除' : '色板里没有'],
    [
      '用 221 识别后没有体系外的色号',
      outside.length === 0,
      outside.length === 0 ? `用到 ${used.size} 种，全在体系内` : `越界：${outside.join(' ')}`,
    ],
  ]

  return {
    name: '色号体系：MARD 221 不会识别出 P/Q/R/T/Y/ZG',
    ok: checks.every(([, ok]) => ok),
    lines: checks.map(([n, ok, d]) => `  ${ok ? '✓' : '✗'} ${n} — ${d}`),
  }
}

/* ----------------------------- 拼块顺序校验 ----------------------------- */

/**
 * 造一种颜色散布在很多大小不一的色块上，比较各排序方式下「手要走多远」。
 * 用户反馈过默认的「大块优先」会满图跳，这里把它固化成回归测试。
 */
function verifyRegionOrdering(): Report {
  const cols = 90
  const rows = 60
  const rng = mulberry32(20260929)
  const indices: number[] = []
  const occupied = new Set<number>()
  for (let by = 1; by < rows - 4; by += 6) {
    for (let bx = 1; bx < cols - 4; bx += 8) {
      if (rng() < 0.3) continue
      const r0 = by + Math.floor(rng() * 3)
      const c0 = bx + Math.floor(rng() * 3)
      const w = 1 + Math.floor(rng() * 3)
      const h = 1 + Math.floor(rng() * 2)
      for (let dr = 0; dr < h; dr++) {
        for (let dc = 0; dc < w; dc++) {
          const i = (r0 + dr) * cols + (c0 + dc)
          if (occupied.has(i)) continue
          occupied.add(i)
          indices.push(i)
        }
      }
    }
  }

  interface Stat {
    mode: RegionOrderMode
    blocks: number
    totalGap: number
    maxJump: number
    first: string
  }

  const gapOf = (a: Region, b: Region) => {
    const dR = Math.max(0, Math.max(a.minR - b.maxR, b.minR - a.maxR))
    const dC = Math.max(0, Math.max(a.minC - b.maxC, b.minC - a.maxC))
    return dR + dC
  }

  const modes: RegionOrderMode[] = ['largest', 'flow', 'rowMajor', 'edgeFirst']
  const stats: Stat[] = modes.map((mode) => {
    const regions = buildRegions(indices, cols, rows, 'snake', mode)
    let totalGap = 0
    let maxJump = 0
    for (let i = 1; i < regions.length; i++) {
      const g = gapOf(regions[i - 1], regions[i])
      totalGap += g
      if (g > maxJump) maxJump = g
    }
    const f = regions[0]
    return {
      mode,
      blocks: regions.length,
      totalGap,
      maxJump,
      first: `行${f.minR + 1} 列${f.minC + 1}`,
    }
  })

  const byMode = new Map(stats.map((s) => [s.mode, s]))
  const largest = byMode.get('largest') as Stat
  const flow = byMode.get('flow') as Stat
  const rowMajor = byMode.get('rowMajor') as Stat

  const lines: string[] = [`共 ${flow.blocks} 个色块，散布在 ${cols}×${rows} 的图上`, '']
  lines.push('  方式            总移动(格)  最大单次跳(格)  第一块位置')
  for (const s of stats) {
    lines.push(
      `  ${s.mode.padEnd(14)} ${String(s.totalGap).padStart(9)} ${String(s.maxJump).padStart(14)}   ${s.first}`,
    )
  }

  // 「就近连续」必须显著优于「大块优先」，且不存在大跳
  const betterThanLargest = flow.totalGap < largest.totalGap / 2
  const noBigJump = flow.maxJump <= largest.maxJump / 3
  // 起点必须是「最靠左上」的那一块（先比上边界，再比左边界）
  const allRegions = buildRegions(indices, cols, rows, 'snake', 'flow')
  const trueTopLeft = allRegions.reduce(
    (best, r) => (r.minR < best.minR || (r.minR === best.minR && r.minC < best.minC) ? r : best),
    allRegions[0],
  )
  const firstRegion = allRegions[0]
  const startsTopLeft = firstRegion === trueTopLeft
  // 逐行扫描必须严格按上边界、再按左边界
  const rowMajorRegions = buildRegions(indices, cols, rows, 'snake', 'rowMajor')
  let sorted = true
  for (let i = 1; i < rowMajorRegions.length; i++) {
    const a = rowMajorRegions[i - 1]
    const b = rowMajorRegions[i]
    if (b.minR < a.minR || (b.minR === a.minR && b.minC < a.minC)) sorted = false
  }

  lines.push('')
  lines.push(
    `判定：就近连续总移动 < 大块优先的 1/2 ${betterThanLargest ? 'OK' : '不达标'}` +
      `（${flow.totalGap} vs ${largest.totalGap}）· ` +
      `无大跳 ${noBigJump ? 'OK' : '不达标'}（最大 ${flow.maxJump} vs ${largest.maxJump}）· ` +
      `从左上开始 ${startsTopLeft ? 'OK' : '不OK'} · ` +
      `逐行严格有序 ${sorted ? 'OK' : '不OK'}` +
      `（逐行最大跳 ${rowMajor.maxJump}）`,
  )

  return {
    name: '拼块顺序：就近连续 / 逐行扫描',
    ok: betterThanLargest && noBigJump && startsTopLeft && sorted,
    lines,
  }
}

/* ----------------------------- 色号格式校验 ----------------------------- */

function verifyCodeFormat(): Report {
  const lines: string[] = []

  // 1) 显示格式：只去掉「数字部分」的前导零
  const cases: [string, string][] = [
    ['D01', 'D1'],
    ['H07', 'H7'],
    ['A01', 'A1'],
    ['C10', 'C10'],
    ['ZG1', 'ZG1'],
    ['IC04', 'IC4'],
    ['IC9', 'IC9'],
    ['DH15', 'DH15'],
    ['YX11', 'YX11'],
    ['W3', 'W3'],
    ['-', '-'],
    ['?', '?'],
    ['65', '65'],
    ['100', '100'],
    ['q05', 'Q5'],
    [' D08 ', 'D8'],
  ]
  const bad = cases.filter(([input, want]) => formatColorCode(input) !== want)
  lines.push(
    `前导零规则：${cases.length - bad.length}/${cases.length} 正确` +
      (bad.length > 0
        ? ` —— 不符：${bad.map(([i, w]) => `${i}→${formatColorCode(i)}(应为${w})`).join('、')}`
        : ''),
  )

  // 2) 同一品牌内规范化后不能撞车
  //    如果两个不同色号规范化成同一个键，索引会静默丢掉一个颜色，非常难查
  const brands = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝'] as const
  const collisions: string[] = []
  for (const brand of brands) {
    const seen = new Map<string, string>()
    for (const p of PALETTE) {
      const raw = p.keys[brand]
      if (!raw || raw === '?' || raw === '-') continue
      const key = formatColorCode(raw)
      const prev = seen.get(key)
      if (prev !== undefined) {
        if (prev !== raw) collisions.push(`${brand}：${prev} 与 ${raw} 都规范化成 ${key}`)
      } else {
        seen.set(key, raw)
      }
    }
  }
  lines.push(
    collisions.length === 0
      ? '同品牌内无规范化撞车'
      : `发现 ${collisions.length} 处撞车：${collisions.slice(0, 4).join('；')}`,
  )

  // 3) 补零与不补零都必须能解析，且指向同一个颜色
  const padded = resolveColorCodes('D01 C07 H07 A01', 'MARD')
  const bare = resolveColorCodes('D1 C7 H7 A1', 'MARD')
  const parseOk =
    padded.indices.length === 4 &&
    bare.indices.length === 4 &&
    padded.indices.join(',') === bare.indices.join(',') &&
    padded.unknown.length === 0 &&
    bare.unknown.length === 0
  lines.push(
    `「D01」与「D1」解析结果一致：${parseOk ? 'OK' : '不OK'}` +
      `（补零 ${padded.indices.join(',')} / 不补零 ${bare.indices.join(',')}）`,
  )

  // 4) 显示出口 codeOf 也必须是不补零的形式
  const shown = PALETTE.map((_, i) => codeOf(i, 'MARD'))
  const paddedShown = shown.filter((c) => /^[A-Z]+0\d+$/.test(c))
  lines.push(
    paddedShown.length === 0
      ? `codeOf 输出的 ${shown.length} 个 MARD 色号全部无前导零`
      : `codeOf 仍输出补零色号 ${paddedShown.length} 个：${paddedShown.slice(0, 5).join(' ')}`,
  )

  return {
    name: '色号格式：不补前导零（D01 → D1）',
    ok: bad.length === 0 && collisions.length === 0 && parseOk && paddedShown.length === 0,
    lines,
  }
}

/* ----------------------------- 主流程 ----------------------------- */

function main() {
  mkdirSync('samples', { recursive: true })

  const cases: CaseSpec[] = [
    {
      name: 'A-标准图纸（网格线+色号+留白边）',
      cols: 48,
      rows: 40,
      cell: 24,
      margin: 36,
      gridLine: [150, 150, 150],
      lineWidth: 1,
      codes: true,
      noise: 0,
      blankRing: 2,
      legend: false,
      pageBg: [255, 255, 255],
    },
    {
      name: 'B-细密图纸（非整数格距+JPEG噪声）',
      cols: 60,
      rows: 44,
      cell: 17.4,
      margin: 21,
      gridLine: [178, 178, 178],
      lineWidth: 1,
      codes: true,
      noise: 4,
      blankRing: 0,
      legend: false,
      pageBg: [252, 252, 250],
    },
    {
      name: 'C-无网格线纯像素图',
      cols: 40,
      rows: 32,
      cell: 20,
      margin: 10,
      gridLine: null,
      lineWidth: 0,
      codes: false,
      noise: 0,
      blankRing: 0,
      legend: false,
      pageBg: [255, 255, 255],
    },
    {
      name: 'D-图纸下方带图例表格',
      cols: 36,
      rows: 30,
      cell: 22,
      margin: 28,
      gridLine: [140, 140, 140],
      lineWidth: 1,
      codes: true,
      noise: 0,
      blankRing: 0,
      legend: true,
      pageBg: [255, 255, 255],
    },
    {
      name: 'E-灰底大格图纸',
      cols: 30,
      rows: 26,
      cell: 30,
      margin: 24,
      gridLine: [90, 90, 90],
      lineWidth: 2,
      codes: true,
      noise: 3,
      blankRing: 1,
      legend: false,
      pageBg: [243, 244, 246],
    },
  ]

  const reports: Report[] = []
  cases.forEach((spec, i) => {
    const c = renderCase(spec, 1000 + i * 37)
    const file = `samples/${String.fromCharCode(97 + i)}-${spec.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.png`
    writeFileSync(file, c.png)
    const rep = verifyCase(c)
    rep.lines.unshift(`文件：${file}  (${decodePng(c.png).width}×${decodePng(c.png).height})`)
    reports.push(rep)
  })

  console.log('\n================ 识别验证 ================\n')
  for (const r of reports) {
    console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}`)
    for (const l of r.lines) console.log('    ' + l)
    console.log('')
  }

  console.log('================ 色板约束 ================\n')
  const strictRep = verifyStrictPalette(renderCase(cases[0], 777), cases[0])
  console.log(`${strictRep.ok ? '✅ PASS' : '❌ FAIL'}  ${strictRep.name}`)
  for (const l of strictRep.lines) console.log('    ' + l)
  console.log('')
  reports.push(strictRep)

  console.log('================ 颜色缓存 ================\n')
  const cacheRep = verifyColorCacheKey()
  console.log(`${cacheRep.ok ? '✅ PASS' : '❌ FAIL'}  ${cacheRep.name}`)
  for (const l of cacheRep.lines) console.log('    ' + l)
  console.log('')
  reports.push(cacheRep)

  console.log('================ 色号体系 ================\n')
  const sysRep = verifyPaletteSystem(renderCase(cases[0], 909), cases[0])
  console.log(`${sysRep.ok ? '✅ PASS' : '❌ FAIL'}  ${sysRep.name}`)
  for (const l of sysRep.lines) console.log('    ' + l)
  console.log('')
  reports.push(sysRep)

  console.log('================ 拼块顺序 ================\n')
  const order = verifyRegionOrdering()
  console.log(`${order.ok ? '✅ PASS' : '❌ FAIL'}  ${order.name}`)
  for (const l of order.lines) console.log('    ' + l)
  console.log('')
  reports.push(order)

  console.log('================ 色号格式 ================\n')
  const codeFmt = verifyCodeFormat()
  console.log(`${codeFmt.ok ? '✅ PASS' : '❌ FAIL'}  ${codeFmt.name}`)
  for (const l of codeFmt.lines) console.log('    ' + l)
  console.log('')
  reports.push(codeFmt)

  const failed = reports.filter((r) => !r.ok).length
  console.log(`结果：${reports.length - failed}/${reports.length} 通过\n`)
  if (failed > 0) process.exitCode = 1
}

main()
