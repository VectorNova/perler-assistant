/** Local, supervised glyph recognition. Printed labels are decoded independently of fill colour. */
import type { ChartRecognition, GridSpec, RGB } from '../types'
import { codeOf, deltaE2000, PALETTE, rgbToLab } from './color'
import fontAsset from '../data/ocrGlyphTemplates.json'
import legendFontAsset from '../data/legendGlyphTemplates.json'
import { detectChartLegend } from './chartLegend'
import { sampleCells } from './sample'

const W = 20
const H = 28
const SIZE = W * H

interface Glyph {
  bits: Uint8Array
  ratio: number
  key: string
}
interface Label {
  glyphs: Glyph[]
  fill: RGB
  fillKey: number
}
interface Template extends Glyph { char: string }
interface Reading { index: number; confidence: number; score: number }

// A compact pixel-font vocabulary, including the open/closed strokes of 6 and 8.
// These are semantic glyph templates, never image-specific colour/code mappings.
const PIXEL: Record<string, string> = {
  '0': '01110/10001/10011/10101/11001/10001/01110',
  '1': '010/110/010/010/010/010/111',
  '2': '01110/10001/00001/00110/01000/10000/11111',
  '3': '01110/10001/00001/00110/00001/10001/01110',
  '4': '1001/1001/1001/1111/0001/0001/0001',
  '5': '01111/01000/01000/01110/00001/10001/01110',
  '6': '01110/10001/10000/11110/10001/10001/01110',
  '7': '1111/0001/0001/0010/0010/0100/0100',
  '8': '01110/10001/10001/01110/10001/10001/01110',
  '9': '01110/10001/10001/01111/00001/10001/01110',
  A: '01110/10001/10001/11111/10001/10001/10001',
  B: '11110/10001/10001/11110/10001/10001/11110',
  C: '01110/10001/10000/10000/10000/10001/01110',
  D: '11100/10010/10001/10001/10001/10001/11110',
  E: '1111/1000/1000/1111/1000/1000/1111',
  F: '1111/1000/1000/1110/1000/1000/1000',
  G: '01110/10001/10000/10111/10001/10001/01110',
  H: '10001/10001/10001/11111/10001/10001/10001',
  I: '111/010/010/010/010/010/111',
  J: '00111/00010/00010/00010/00010/10010/01100',
  K: '10001/10010/10100/11000/10100/10010/10001',
  L: '1000/1000/1000/1000/1000/1000/1111',
  M: '1000010/1100010/1100111/1010101/1001001/1000001/1000001',
  N: '10001/11001/11001/10101/10011/10011/10001',
}

function normalized(mask: Uint8Array, width: number, x0: number, y0: number, x1: number, y1: number): Glyph {
  const rawW = x1 - x0 + 1
  const rawH = y1 - y0 + 1
  const bits = new Uint8Array(SIZE)
  for (let y = 0; y < H; y++) {
    const sy = y0 + Math.min(rawH - 1, Math.floor((y + 0.5) * rawH / H))
    for (let x = 0; x < W; x++) {
      const sx = x0 + Math.min(rawW - 1, Math.floor((x + 0.5) * rawW / W))
      bits[y * W + x] = mask[sy * width + sx]
    }
  }
  let key = ''
  for (let k = 0; k < SIZE; k += 16) {
    let word = 0
    for (let j = 0; j < 16; j++) word |= bits[k + j] << j
    key += String.fromCharCode(word)
  }
  key += ':' + Math.round(rawW / rawH * 100)
  return { bits, ratio: rawW / rawH, key }
}

function splitMask(mask: Uint8Array, width: number, height: number): Glyph[] {
  const glyphs: Glyph[] = []
  let start = -1
  const flush = (end: number) => {
    let y0 = height
    let y1 = -1
    let ink = 0
    for (let x = start; x <= end; x++) {
      for (let y = 0; y < height; y++) if (mask[y * width + x]) {
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
        ink++
      }
    }
    if (y1 >= y0 && y1 - y0 >= 3 && ink >= 4) glyphs.push(normalized(mask, width, start, y0, end, y1))
    start = -1
  }
  for (let x = 0; x <= width; x++) {
    let ink = false
    if (x < width) for (let y = 0; y < height; y++) if (mask[y * width + x]) { ink = true; break }
    if (ink && start < 0) start = x
    if (!ink && start >= 0) flush(x - 1)
  }
  return glyphs
}

function extract(img: ImageData, grid: GridSpec, col: number, row: number, inkThreshold?: number): Label {
  const insetX = Math.max(2, Math.round(grid.cellW * 0.12))
  const insetY = Math.max(2, Math.round(grid.cellH * 0.12))
  const x0 = Math.round(grid.offsetX + col * grid.cellW) + insetX
  const y0 = Math.round(grid.offsetY + row * grid.cellH) + insetY
  const width = Math.max(1, Math.round(grid.cellW) - 2 * insetX)
  const height = Math.max(1, Math.round(grid.cellH) - 2 * insetY)
  const empty = { glyphs: [], fill: [255, 255, 255] as RGB, fillKey: 0xffffff }
  if (x0 < 0 || y0 < 0 || x0 + width > img.width || y0 + height > img.height) return empty
  const hist = new Map<number, number>()
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = ((y0 + y) * img.width + x0 + x) * 4
    if (img.data[p + 3] < 128) continue
    const key = (img.data[p] << 16) | (img.data[p + 1] << 8) | img.data[p + 2]
    hist.set(key, (hist.get(key) ?? 0) + 1)
  }
  let fillKey = 0xffffff
  let fillN = 0
  for (const [key, n] of hist) if (n > fillN) { fillKey = key; fillN = n }
  const fill: RGB = [fillKey >> 16, (fillKey >> 8) & 255, fillKey & 255]
  const mask = new Uint8Array(width * height)
  let inkN = 0
  // Require actual black/white ink. Grey watermarks and saturated grid lines are excluded.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = ((y0 + y) * img.width + x0 + x) * 4
    if (img.data[p + 3] < 128) continue
    const r = img.data[p], g = img.data[p + 1], b = img.data[p + 2]
    const dr = r - fill[0], dg = g - fill[1], db = b - fill[2]
    // A pale-grey watermark on an even paler cell is not white ink. Require the
    // actual direction of contrast, rather than accepting both RGB extremes blindly.
    const fillSum = fill[0] + fill[1] + fill[2]
    // JPEG 色块内的黑字边缘会染上底色（蓝底尤其明显），固定通道阈值会
    // 截掉笔画。独立图例标签用相对填色的对比度恢复半透明边缘。
    const ink = inkThreshold !== undefined
      ? ((dr + dg + db < -fillSum * inkThreshold && Math.max(r, g, b) < 180)
        || (dr + dg + db > (765 - fillSum) * inkThreshold && Math.min(r, g, b) > 175))
      : (Math.min(r, g, b) > 175 && dr + dg + db > 0)
        || (Math.max(r, g, b) < 120 && dr + dg + db < 0)
    if (ink && dr * dr + dg * dg + db * db > 100 * 100) {
      mask[y * width + x] = 1
      inkN++
    }
  }
  if (inkN < 5 || inkN / (width * height) > 0.55) return { glyphs: [], fill, fillKey }
  return { glyphs: splitMask(mask, width, height), fill, fillKey }
}

function distance(a: Glyph, b: Glyph): number {
  let d = 0
  for (let i = 0; i < SIZE; i++) d += a.bits[i] !== b.bits[i] ? 1 : 0
  return d / SIZE + Math.min(0.15, Math.abs(Math.log(a.ratio / b.ratio)) * 0.10)
}

let builtin: Template[] | undefined
function templates(): Template[] {
  if (builtin) return builtin
  builtin = []
  for (const [char, pattern] of Object.entries(PIXEL)) {
    const lines = pattern.split('/')
    const mask = Uint8Array.from(lines.join(''), (v) => v === '1' ? 1 : 0)
    builtin.push({ ...normalized(mask, lines[0].length, 0, 0, lines[0].length - 1, lines.length - 1), char })
  }
  for (const { char, width, height, bits } of fontAsset.templates) {
    const mask = Uint8Array.from(bits, (v) => v === '1' ? 1 : 0)
    builtin.push({ ...normalized(mask, width, 0, 0, width - 1, height - 1), char })
  }
  // Static semantic templates make the same pixels produce the same result on Android,
  // iOS, workers and desktop; no installed font or browser text rasterizer is required.
  return builtin
}

/** Learn digit semantics from an independently checked 1,2,3... coordinate strip. */
function learnDigits(img: ImageData, grid: GridSpec): Template[] {
  const learned: Template[] = []
  for (const axis of ['top', 'left'] as const) {
    const samples: { char: string; glyph: Glyph }[] = []
    let matching = 0
    const n = Math.min(45, axis === 'top' ? grid.cols : grid.rows)
    if (n < 10) continue
    for (let k = 0; k < n; k++) {
      const glyphs = extract(img, grid, axis === 'top' ? k : -1, axis === 'top' ? -1 : k).glyphs
      const number = String(k + 1)
      if (glyphs.length !== number.length) continue
      matching++
      glyphs.forEach((glyph, p) => samples.push({ char: number[p], glyph }))
    }
    if (matching / n < 0.75) continue
    const modes = new Map<string, { glyph: Glyph; count: number }>()
    for (const { char, glyph } of samples) {
      const key = char + glyph.key
      const old = modes.get(key)
      if (old) old.count++
      else modes.set(key, { glyph, count: 1 })
    }
    const centers = new Map<string, Glyph>()
    for (const digit of '0123456789') {
      const options = [...modes].filter(([key]) => key[0] === digit).sort((a, b) => b[1].count - a[1].count)
      if (options.length) centers.set(digit, options[0][1].glyph)
    }
    if (centers.size < 9) continue
    const consistent = samples.filter(({ char, glyph }) => distance(glyph, centers.get(char)!) < 0.16).length
    if (consistent / samples.length < 0.85) continue
    // Distinct labels must represent distinct shapes; a repeated decorative symbol is not a ruler.
    let distinct = true
    const entries = [...centers]
    for (let i = 0; i < entries.length; i++) for (let j = 0; j < i; j++) {
      if (distance(entries[i][1], entries[j][1]) < 0.018) distinct = false
    }
    if (!distinct) continue
    for (const [char, glyph] of centers) learned.push({ ...glyph, char })
  }
  return learned
}

function codeVocabulary() {
  return PALETTE.flatMap((_, index) => {
    const canonical = codeOf(index, 'MARD')
    const printed = PALETTE[index]?.keys.MARD
    return [...new Set([canonical, printed])].filter((code) => code && /^[A-Z][0-9]+$/.test(code))
      .map((code) => ({ index, code }))
  })
}

/** 格内与图例使用同一字形语义；颜色不参与字符排名。 */
function glyphReader(vocabulary: Template[], codes = codeVocabulary()) {
  const cache = new Map<string, Map<string, number>>()
  const rank = (glyph: Glyph, first: boolean): Map<string, number> => {
    const key = (first ? 'L' : 'D') + glyph.key
    const previous = cache.get(key)
    if (previous) return previous
    const scores = new Map<string, number>()
    for (const template of vocabulary) {
      if (first ? !/^[A-Z]$/.test(template.char) : !/[0-9]/.test(template.char)) continue
      const score = distance(glyph, template)
      if (score < (scores.get(template.char) ?? Infinity)) scores.set(template.char, score)
    }
    cache.set(key, scores)
    return scores
  }
  const read = (glyphs: Glyph[]): Reading | null => {
    if (glyphs.length < 2 || glyphs.length > 4) return null
    const ranks = glyphs.map((glyph, p) => rank(glyph, p === 0))
    const possible = codes.filter(({ code }) => code.length === glyphs.length).map(({ index, code }) => {
      const scores = ranks.map((r, p) => r.get(code[p]) ?? 1)
      return { index, code, score: scores.reduce((sum, s) => sum + s, 0) / scores.length, worst: Math.max(...scores) }
    }).sort((a, b) => a.score - b.score)
    const best = possible[0]
    if (!best || best.score > 0.25 || best.worst > 0.34) return null
    const independentBest = ranks.map((r) => Math.min(...r.values()))
    if (ranks.some((r, p) => (r.get(best.code[p]) ?? 1) > independentBest[p] + 0.045)) return null
    // Only differing characters carry evidence between two codes. Shared D/1 strokes must
    // not dilute a clear 6-vs-8 distinction just because the label has three characters.
    let margin = 1
    for (const alternative of possible) {
      if (alternative.index === best.index) continue
      let difference = 0
      let positions = 0
      for (let p = 0; p < best.code.length; p++) if (best.code[p] !== alternative.code[p]) {
        difference += (ranks[p].get(alternative.code[p]) ?? 1) - (ranks[p].get(best.code[p]) ?? 1)
        positions++
      }
      margin = Math.min(margin, positions ? difference / positions : 0)
    }
    // Rasterizers differ by edge pixels. Confidence depends on separation as well as error;
    // the independent Arial fixture has 10-12% error but a clear correct-character margin.
    const cert = Math.min(1, Math.max(0, 1 - best.score * 0.55)) * Math.min(1, margin / 0.025)
    return { index: best.index, score: best.score, confidence: cert }
  }
  return { rank, read }
}

export interface PrintedLabelBox { x: number; y: number; w: number; h: number }
export interface PrintedLabelReading {
  index: number; confidence: number; score: number; rgb: RGB
  conflict?: boolean
  alternatives?: number[]
  supportingVariants?: number
}

let legendTemplates: Template[] | undefined
function printedTemplates(): Template[] {
  return legendTemplates ??= legendFontAsset.templates.map(({ char, width, height, bits }) => ({
    ...normalized(Uint8Array.from(bits, (v) => v === '1' ? 1 : 0), width, 0, 0, width - 1, height - 1), char,
  }))
}

/** 读取独立定位的矩形标签，供图例校验；未读清时返回 -1。 */
export function recognizePrintedLabels(img: ImageData, boxes: PrintedLabelBox[], grid?: GridSpec): PrintedLabelReading[] {
  const learned = grid ? learnDigits(img, grid) : []
  const readers = [glyphReader([...templates(), ...learned]), glyphReader([...printedTemplates(), ...learned])]
  return boxes.map((box) => {
    const labelGrid = { offsetX: box.x, offsetY: box.y, cellW: box.w, cellH: box.h, cols: 1, rows: 1 }
    const labels = [undefined, 0.35, 0.4, 0.45, 0.48, 0.5, 0.55, 0.6].map((threshold) => extract(img, labelGrid, 0, 0, threshold))
    const variants = labels.map((label) => readers.flatMap((reader) => {
      const result = reader.read(label.glyphs); return result ? [result] : []
    }))
    const readings = variants.flat()
    const reliable = readings.filter((reading) => reading.confidence >= 0.85)
    // 多种二值化阈值必须给出一致色号；清晰但互相矛盾的结果不能定案。
    const consistent = new Set(reliable.map((reading) => reading.index)).size <= 1
    const reading = consistent ? [...readings].sort((a, b) => b.confidence - a.confidence || a.score - b.score)[0] : undefined
    return { index: reading?.index ?? -1, confidence: reading?.confidence ?? 0, score: reading?.score ?? 1, rgb: labels[0].fill,
      conflict: !consistent, alternatives: [...new Set(reliable.map((result) => result.index))],
      supportingVariants: reading ? variants.filter((results) => results.some((result) => result.index === reading.index && result.confidence >= 0.85)).length : 0 }
  })
}

/** 完整几何之外，还需逐项有独立文字或明确色块证据；缺项时整张图例不生效。 */
function recognizeLegend(img: ImageData, grid: GridSpec, indices: Int16Array, confidence: Float32Array) {
  const geometry = detectChartLegend(img, grid)
  if (!geometry || geometry.confidence < 0.9) return undefined
  const labels = recognizePrintedLabels(img, geometry.swatches, grid)
  // 彩色装饰矩形也可能排列整齐。必须有大部分独立色号文字作证，
  // RGB 只能补少数模糊标签，不能凭颜色生成整张图例。
  if (labels.filter((label) => label.index >= 0 && label.confidence >= 0.85).length < Math.max(2, labels.length * 0.8)) return undefined
  const sampled = sampleCells(img, grid)
  const anchors = geometry.swatches.map((swatch, i) => {
    const label = labels[i]
    if (label.index >= 0 && label.confidence >= 0.85) return { index: label.index, rgb: swatch.rgb }
    const lab = rgbToLab(swatch.rgb)
    const ranked = PALETTE.map((entry, index) => ({ index, d: deltaE2000(lab, entry.lab) })).sort((a, b) => a.d - b.d)
    // 字形未读清时，仅允许颜色非常贴近且与第二候选明确分离的色块补全。
    const best = ranked[0], next = ranked[1]
    if (best.d > 3 || next.d - best.d < 2 || (label.confidence > 0.55 && label.index !== best.index)) return undefined
    if (label.conflict && !label.alternatives?.includes(best.index)) return undefined
    const votes = new Map<number, number>()
    for (let cell = 0; cell < indices.length; cell++) {
      if (indices[cell] < 0 || confidence[cell] < 0.85 || sampled.purity[cell] < 0.55) continue
      const fill: RGB = [sampled.rgb[cell * 3], sampled.rgb[cell * 3 + 1], sampled.rgb[cell * 3 + 2]]
      if (deltaE2000(rgbToLab(fill), lab) > 2) continue
      votes.set(indices[cell], (votes.get(indices[cell]) ?? 0) + 1)
    }
    const total = [...votes.values()].reduce((sum, count) => sum + count, 0)
    // 公共色板色值不是色号真值；还需本图纸可靠格内文字独立支持，
    // 才能补全一个被压缩损坏的图例标签。
    const support = votes.get(best.index) ?? 0
    const competing = Math.max(0, ...[...votes].filter(([index]) => index !== best.index).map(([, count]) => count))
    if (support < Math.max(3, total * 0.7) || support < competing * 3) return undefined
    return { index: best.index, rgb: swatch.rgb }
  })
  if (anchors.some((anchor) => !anchor)) return undefined
  const complete = anchors.filter((anchor) => !!anchor)
  if (new Set(complete.map((anchor) => anchor.index)).size !== geometry.swatches.length) return undefined
  return { indices: complete.map((anchor) => anchor.index), anchors: complete, swatches: complete.length, recognized: complete.length }
}

export function recognizeChart(img: ImageData, grid: GridSpec): ChartRecognition {
  const n = grid.cols * grid.rows
  const indices = new Int16Array(n).fill(-1)
  const confidence = new Float32Array(n)
  const hasText = new Uint8Array(n)
  const weakIndices = new Int16Array(n).fill(-1)
  // Decode independently of user palette constraints; a restricted vocabulary can
  // turn a weak D8 into the sole permitted D6 and erase the conflict evidence.
  const codes = codeVocabulary()
  const learned = learnDigits(img, grid)
  const vocabulary = [...templates(), ...learned]
  const { rank, read } = glyphReader(vocabulary, codes)
  const groups = new Map<number, { cells: { index: number; glyphs: Glyph[] }[]; votes: Map<number, { n: number; quality: number }> }>()
  let textCells = 0
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
    const i = row * grid.cols + col
    const label = extract(img, grid, col, row)
    if (label.glyphs.length >= 1 && label.glyphs.length <= 4) { hasText[i] = 1; textCells++ }
    let group = groups.get(label.fillKey)
    if (!group) { group = { cells: [], votes: new Map() }; groups.set(label.fillKey, group) }
    group.cells.push({ index: i, glyphs: label.glyphs })
    const reading = read(label.glyphs)
    if (!reading) continue
    weakIndices[i] = reading.index
    if (reading.confidence >= 0.85) {
      indices[i] = reading.index
      confidence[i] = reading.confidence
    }
    if (reading.confidence >= 0.55 && reading.score < 0.20) {
      const vote = group.votes.get(reading.index) ?? { n: 0, quality: 0 }
      vote.n++
      vote.quality += reading.confidence
      group.votes.set(reading.index, vote)
    }
  }
  let propagatedCells = 0
  // Propagate only a repeated, consistent text reading within an exact RGB fill group.
  // Different high-confidence printed labels always retain their own results.
  for (const group of groups.values()) {
    const votes = [...group.votes].sort((a, b) => b[1].n - a[1].n)
    const best = votes[0]
    if (!best || best[1].n < 3) continue
    const total = votes.reduce((sum, [, v]) => sum + v.n, 0)
    if (best[1].n / total < 0.90 || best[1].n < group.cells.length * 0.35) continue
    for (const { index: i, glyphs } of group.cells) if (indices[i] < 0 && hasText[i]) {
      if (weakIndices[i] >= 0 && weakIndices[i] !== best[0]) continue
      // Colour agreement cannot erase contradictory letters/digits (e.g. one X8 among D6).
      // A proposed group label must remain a plausible reading of this particular cell.
      const supported = codes.some(({ index, code }) => {
        if (index !== best[0] || code.length !== glyphs.length) return false
        return glyphs.every((glyph, p) => {
          const scores = rank(glyph, p === 0)
          const score = scores.get(code[p]) ?? 1
          return score < 0.28 && score <= Math.min(...scores.values()) + 0.025
        })
      })
      if (!supported) continue
      indices[i] = best[0]
      confidence[i] = 0.90
      propagatedCells++
    }
  }
  let recognizedCells = 0
  const legend = recognizeLegend(img, grid, indices, confidence)
  if (legend) {
    const sampled = sampleCells(img, grid)
    const anchors = legend.anchors.map((anchor) => ({ index: anchor.index, lab: rgbToLab(anchor.rgb) }))
    const suspects: number[] = []
    for (let i = 0; i < n; i++) {
      if (!hasText[i] || sampled.purity[i] <= 0) continue
      const color: RGB = [sampled.rgb[i * 3], sampled.rgb[i * 3 + 1], sampled.rgb[i * 3 + 2]]
      const lab = rgbToLab(color)
      const ranked = anchors.map((anchor) => ({ index: anchor.index, d: deltaE2000(lab, anchor.lab) })).sort((a, b) => a.d - b.d)
      const own = ranked.find((anchor) => anchor.index === indices[i])
      const conflict = indices[i] >= 0 && (!own || (ranked[0].d <= 2 && own.d - ranked[0].d >= 6))
      if (conflict || (indices[i] < 0 && sampled.purity[i] < 0.85 && ranked[0].d > 3)) suspects.push(i)
    }
    const readings = recognizePrintedLabels(img, suspects.map((i) => ({
      x: grid.offsetX + (i % grid.cols) * grid.cellW,
      y: grid.offsetY + Math.floor(i / grid.cols) * grid.cellH,
      w: grid.cellW, h: grid.cellH,
    })), grid)
    for (let k = 0; k < suspects.length; k++) {
      const reading = readings[k], i = suspects[k]
      if (reading.index < 0 || reading.confidence < 0.85 || (reading.supportingVariants ?? 0) < 3 || !legend.indices.includes(reading.index)) continue
      // 已采信的字形只有在新字形与独立图例填色同时支持时才改，
      // 相同 RGB 的真实单格不同色号不会因多数票被合并。
      if (indices[i] >= 0 && legend.indices.includes(indices[i]) && reading.index !== indices[i]) {
        const fill = rgbToLab([sampled.rgb[i * 3], sampled.rgb[i * 3 + 1], sampled.rgb[i * 3 + 2]])
        const proposed = anchors.find((anchor) => anchor.index === reading.index)!
        const current = anchors.find((anchor) => anchor.index === indices[i])!
        if (deltaE2000(fill, proposed.lab) > 2 || deltaE2000(fill, current.lab) - deltaE2000(fill, proposed.lab) < 6) continue
      }
      indices[i] = reading.index
      confidence[i] = reading.confidence
    }
  }
  for (const index of indices) if (index >= 0) recognizedCells++
  return {
    indices, confidence, hasText,
    legend,
    summary: { textCells, recognizedCells, propagatedCells, unresolvedCells: textCells - recognizedCells, learnedDigits: new Set(learned.map((t) => t.char)).size },
  }
}
