/** 独立标注的小图验证本图填色校准、真实少量色与水印背景。 */
import { buildPattern, CELL_TEXT_UNCERTAIN, CELL_TEXT_CONFLICT, lowConfidenceCells } from '../src/lib/pattern'
import { PALETTE, resolveColorCodes } from '../src/lib/color'
import { sampleCells } from '../src/lib/sample'
import type { ChartRecognition, GridSpec, RGB } from '../src/types'

function index(code: string): number { return resolveColorCodes(code, 'MARD').indices[0] }
function chart(colors: RGB[]) {
  const size = 40
  const width = colors.length * size
  const data = new Uint8ClampedArray(width * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4
    data.set([...colors[Math.floor(x / size)], 255], p)
  }
  return {
    img: { width, height: size, data } as unknown as ImageData,
    grid: { offsetX: 0, offsetY: 0, cellW: size, cellH: size, cols: colors.length, rows: 1 } as GridSpec,
  }
}
function text(labels: number[]): ChartRecognition {
  const recognized = labels.filter((v) => v >= 0).length
  return {
    indices: Int16Array.from(labels),
    confidence: Float32Array.from(labels, (v) => v >= 0 ? 0.99 : 0),
    hasText: Uint8Array.from(labels, () => 1),
    summary: { textCells: labels.length, recognizedCells: recognized, propagatedCells: 0, unresolvedCells: labels.length - recognized, learnedDigits: 0 },
  }
}
const checks: { name: string; passed: boolean; detail: string }[] = []
function check(name: string, passed: boolean, detail: string) { checks.push({ name, passed, detail }) }
const base = { name: 'fill-calibration', imageUrl: '', imageHash: 'fill-calibration', dropBackground: false }
const d17 = index('D17')
const c27 = index('C27')

// 图纸的D17填色故意等于公共C27；色号真值由独立文字给出，不从RGB反推。
const repeated = chart(Array.from({ length: 5 }, () => PALETTE[c27].rgb))
const repeatedText = text([d17, d17, d17, -1, c27])
const calibrated = buildPattern(repeated.img, repeated.grid, { ...base, textRecognition: repeatedText })
const uncalibrated = buildPattern(repeated.img, repeated.grid, { ...base, textRecognition: repeatedText, calibrateFromText: false })
check('重复色号校准本图填色，修复缺字格', calibrated.pattern.cells[3] === d17 && uncalibrated.pattern.cells[3] === c27 && calibrated.calibratedCells === 1,
  `calibrated=${calibrated.calibratedCells}; unresolved=${calibrated.pattern.cells[3]}`)
check('同RGB下可靠单格不同色号仍保留', calibrated.pattern.cells[4] === c27, `singleton=${calibrated.pattern.cells[4]}`)

const ambiguous = chart(Array.from({ length: 7 }, () => PALETTE[c27].rgb))
const ambiguousResult = buildPattern(ambiguous.img, ambiguous.grid, { ...base, textRecognition: text([d17, d17, d17, c27, c27, c27, -1]) })
check('同填色重复不同文字存在歧义时不强推多数', ambiguousResult.calibratedCells === 0 && ambiguousResult.pattern.cells[6] === c27,
  `calibrated=${ambiguousResult.calibratedCells}`)

const g15 = index('G15')
const h21 = index('H21')
const rare = chart([PALETTE[g15].rgb, PALETTE[g15].rgb, PALETTE[g15].rgb, PALETTE[h21].rgb])
const rareResult = buildPattern(rare.img, rare.grid, { ...base, textRecognition: text([g15, g15, g15, -1]) })
check('真实无字单格近色不被高频近色吞掉', rareResult.pattern.cells[3] === h21 && rareResult.calibratedCells === 0,
  `rare=${rareResult.pattern.cells[3]}`)

const noisy = chart([[224, 224, 224]])
for (let y = 0; y < noisy.img.height; y++) for (let x = 0; x < noisy.img.width; x++) {
  const p = (y * noisy.img.width + x) * 4
  for (let channel = 0; channel < 3; channel++) noisy.img.data[p + channel] = 224 + ((x * (channel + 1) + y) % 2 ? 1 : -1)
}
const sampled = sampleCells(noisy.img, noisy.grid)
check('量化桶边界的微小噪声合计为同一主色', sampled.purity[0] > 0.99 && Array.from(sampled.rgb).every((v) => Math.abs(v - 224) <= 1),
  `purity=${sampled.purity[0]}; rgb=${sampled.rgb}`)

const constrained = buildPattern(repeated.img, repeated.grid, { ...base, allowed: [c27], textRecognition: repeatedText })
check('文字填色校准遵守手工候选限制', Array.from(constrained.pattern.cells).every((v) => v === c27), `cells=${constrained.pattern.cells}`)

const h7 = index('H7')
const suspicious = buildPattern(repeated.img, repeated.grid, { ...base, textRecognition: text([d17, d17, d17, -1, h7]) })
check('高字形置信的异常单格保留并提示核对', suspicious.pattern.cells[4] === h7 &&
  ((suspicious.pattern.flags?.[4] ?? 0) & CELL_TEXT_UNCERTAIN) !== 0 && lowConfidenceCells(suspicious.pattern).includes(4),
  `singleton=${suspicious.pattern.cells[4]}; flags=${suspicious.pattern.flags?.[4]}`)

const legendText = text([d17, d17, d17, -1, h7])
legendText.legend = { indices: [d17, c27], anchors: [{ index: d17, rgb: PALETTE[c27].rgb }, { index: c27, rgb: [0, 0, 0] }], swatches: 2, recognized: 2 }
const legendResult = buildPattern(repeated.img, repeated.grid, { ...base, textRecognition: legendText })
check('完整图例用本图填色收窄候选，并拒绝图例外假OCR',
  Array.from(legendResult.pattern.cells).every((v) => v === d17) &&
  ((legendResult.pattern.flags?.[4] ?? 0) & CELL_TEXT_CONFLICT) !== 0 && legendResult.pattern.recognition?.legendColors === 2,
  `cells=${legendResult.pattern.cells}; flags=${legendResult.pattern.flags?.[4]}`)
const legendConstrained = buildPattern(repeated.img, repeated.grid, { ...base, allowed: [c27], textRecognition: legendText })
check('自动图例不能突破手工候选边界', Array.from(legendConstrained.pattern.cells).every((v) => v === c27),
  `cells=${legendConstrained.pattern.cells}`)
const strictLegend = buildPattern(repeated.img, repeated.grid, { ...base, allowForeignColors: true, textRecognition: legendText })
check('完整图例即使开启外来颜色也不放入假OCR色号',
  Array.from(strictLegend.pattern.cells).every((v) => v === d17) && strictLegend.foreign === 0 &&
  ((strictLegend.pattern.flags?.[4] ?? 0) & CELL_TEXT_CONFLICT) !== 0,
  `cells=${strictLegend.pattern.cells}; foreign=${strictLegend.foreign}`)
const disjointLegend = buildPattern(repeated.img, repeated.grid, { ...base, allowed: [h7], textRecognition: legendText })
check('图例与手工候选无交集时保持手工限制并提示冲突',
  Array.from(disjointLegend.pattern.cells).every((v) => v === h7) &&
  ((disjointLegend.pattern.flags?.[0] ?? 0) & CELL_TEXT_CONFLICT) !== 0,
  `cells=${disjointLegend.pattern.cells}; flags=${disjointLegend.pattern.flags?.[0]}`)

const duplicateFillText = { ...repeatedText,
  legend: { indices: [d17, c27], anchors: [{ index: d17, rgb: PALETTE[c27].rgb }, { index: c27, rgb: PALETTE[c27].rgb }], swatches: 2, recognized: 2 },
}
const duplicateFill = buildPattern(repeated.img, repeated.grid, { ...base, textRecognition: duplicateFillText })
check('图例中相同RGB的真实单格色号保留，缺字格提示歧义',
  duplicateFill.pattern.cells[4] === c27 && duplicateFill.calibratedCells === 0 && lowConfidenceCells(duplicateFill.pattern).includes(3),
  `singleton=${duplicateFill.pattern.cells[4]}; flags=${duplicateFill.pattern.flags?.[3]}`)
const withinLegendText = { ...text([d17, d17, d17, -1, h7]),
  legend: { indices: [d17, h7], anchors: [{ index: d17, rgb: PALETTE[c27].rgb }, { index: h7, rgb: [0, 0, 0] as RGB }], swatches: 2, recognized: 2 },
}
const withinLegend = buildPattern(repeated.img, repeated.grid, { ...base, textRecognition: withinLegendText })
check('图例内高置信误读与填色矛盾时保留文字并给出核对建议',
  withinLegend.pattern.cells[4] === h7 && withinLegend.pattern.second?.[4] === d17 &&
  ((withinLegend.pattern.flags?.[4] ?? 0) & CELL_TEXT_UNCERTAIN) !== 0 &&
  ((withinLegend.pattern.flags?.[4] ?? 0) & CELL_TEXT_CONFLICT) === 0,
  `singleton=${withinLegend.pattern.cells[4]}; flags=${withinLegend.pattern.flags?.[4]}; suggestion=${withinLegend.pattern.second?.[4]}`)
const partialResult = buildPattern(repeated.img, repeated.grid, { ...base, textRecognition: { ...legendText, legend: { ...legendText.legend, recognized: 1 } } })
check('图例不完整时不擅自删掉图例外颜色', partialResult.pattern.cells[4] === h7 && partialResult.pattern.recognition?.legendColors === undefined,
  `singleton=${partialResult.pattern.cells[4]}`)

const watermarked = chart([[218, 194, 200], ...Array.from({ length: 24 }, () => PALETTE[c27].rgb)])
// 空白格被水印覆盖大部分，左边留下约20%的干净纸面。
for (let y = 0; y < watermarked.img.height; y++) for (let x = 0; x < 11; x++) {
  watermarked.img.data.set([254, 254, 254, 255], (y * watermarked.img.width + x) * 4)
}
const watermarkText = text([-1, ...Array.from({ length: 24 }, () => c27)])
watermarkText.hasText[0] = 0
watermarkText.summary.textCells = 24
const cleanedBackground = buildPattern(watermarked.img, watermarked.grid, { ...base, pageBg: [254, 254, 254], dropBackground: true, textRecognition: watermarkText })
check('高覆盖有字图纸用未染色纸面恢复边沿水印空格', cleanedBackground.pattern.blank[0] === 1 && cleanedBackground.backgroundCells === 1,
  `blank=${cleanedBackground.pattern.blank[0]}; background=${cleanedBackground.backgroundCells}`)
const ordinary = buildPattern(watermarked.img, watermarked.grid, { ...base, pageBg: [254, 254, 254], dropBackground: true })
check('无字无图例的普通像素图保留原有判定', ordinary.pattern.blank[0] === 0, `blank=${ordinary.pattern.blank[0]}`)
const unresolvedPaper = buildPattern(watermarked.img, watermarked.grid, { ...base, pageBg: [254, 254, 254], dropBackground: true,
  textRecognition: { ...watermarkText, hasText: Uint8Array.from(watermarkText.hasText, () => 1) } })
check('水印遮挡的有字白豆不会因纸面像素而被删除', unresolvedPaper.pattern.blank[0] === 0, `blank=${unresolvedPaper.pattern.blank[0]}`)

const d1 = index('D1'), d6 = index('D6')
const dirtyFill: RGB = [155, 166, 210]
function stripe(img: ImageData, x0: number, x1: number, rgb: RGB) {
  for (let y = 0; y < img.height; y++) for (let x = x0; x < x1; x++) {
    img.data.set([...rgb, 255], (y * img.width + x) * 4)
  }
}
function dirtyChart(originalWidth: number, noiseWidth = 0, rivalWidth = 0) {
  const fixture = chart([dirtyFill])
  stripe(fixture.img, 5, 5 + originalWidth, PALETTE[d6].rgb)
  if (noiseWidth) stripe(fixture.img, 35 - noiseWidth, 35, [80, 90, 100])
  if (rivalWidth) stripe(fixture.img, 35 - rivalWidth, 35, PALETTE[d1].rgb)
  return fixture
}
const cleanFillText = text([-1])
cleanFillText.legend = { indices: [d1, d6], anchors: [d1, d6].map((index) => ({ index, rgb: PALETTE[index].rgb })), swatches: 2, recognized: 2 }
const recoverable = dirtyChart(6)
const beforeRecovery = buildPattern(recoverable.img, recoverable.grid, { ...base, allowed: [d1, d6] })
const recoveredFill = buildPattern(recoverable.img, recoverable.grid, { ...base, textRecognition: cleanFillText })
check('水印主色偏离图例时用足量未染色环像素恢复原填色',
  beforeRecovery.pattern.cells[0] === d1 && recoveredFill.pattern.cells[0] === d6 && recoveredFill.calibratedCells === 1 &&
  ((recoveredFill.pattern.flags?.[0] ?? 0) & CELL_TEXT_UNCERTAIN) !== 0,
  `原候选=${beforeRecovery.pattern.cells[0]}; 恢复=${recoveredFill.pattern.cells[0]}; purity=${recoveredFill.pattern.purity[0]}`)
check('仅手工候选而无完整图例时不启用水印像素恢复',
  beforeRecovery.calibratedCells === 0 && beforeRecovery.pattern.cells[0] === d1,
  `cells=${beforeRecovery.pattern.cells}; calibrated=${beforeRecovery.calibratedCells}`)

const noEvidence = dirtyChart(0, 4)
const noEvidenceResult = buildPattern(noEvidence.img, noEvidence.grid, { ...base, textRecognition: cleanFillText })
check('水印环内没有原填色证据时保留候选并交人工核对',
  noEvidenceResult.pattern.cells[0] === d1 && noEvidenceResult.calibratedCells === 0 && lowConfidenceCells(noEvidenceResult.pattern).includes(0),
  `cells=${noEvidenceResult.pattern.cells}; calibrated=${noEvidenceResult.calibratedCells}`)
const tinyEvidence = dirtyChart(1, 4)
const tinyEvidenceResult = buildPattern(tinyEvidence.img, tinyEvidence.grid, { ...base, textRecognition: cleanFillText })
check('少于32个原填色像素不能触发恢复',
  tinyEvidenceResult.pattern.cells[0] === d1 && tinyEvidenceResult.calibratedCells === 0 && tinyEvidenceResult.pattern.purity[0] <= 0.85,
  `cells=${tinyEvidenceResult.pattern.cells}; purity=${tinyEvidenceResult.pattern.purity[0]}`)
const weakEvidence = dirtyChart(2, 4)
const weakEvidenceResult = buildPattern(weakEvidence.img, weakEvidence.grid, { ...base, textRecognition: cleanFillText })
check('原填色像素超过32但少于环内一成也不触发恢复',
  weakEvidenceResult.pattern.cells[0] === d1 && weakEvidenceResult.calibratedCells === 0 && weakEvidenceResult.pattern.purity[0] <= 0.85,
  `cells=${weakEvidenceResult.pattern.cells}; purity=${weakEvidenceResult.pattern.purity[0]}`)
const competingEvidence = dirtyChart(6, 0, 5)
const competingResult = buildPattern(competingEvidence.img, competingEvidence.grid, { ...base, textRecognition: cleanFillText })
check('两个图例色都残留且支持未拉开两倍时不强猜',
  competingResult.pattern.cells[0] === d1 && competingResult.calibratedCells === 0,
  `cells=${competingResult.pattern.cells}; calibrated=${competingResult.calibratedCells}`)
const pureDirty = dirtyChart(3)
const pureDirtyResult = buildPattern(pureDirty.img, pureDirty.grid, { ...base, textRecognition: cleanFillText })
check('主填色纯度超过85%时不以少量原色像素替换',
  pureDirtyResult.pattern.cells[0] === d1 && pureDirtyResult.calibratedCells === 0 && pureDirtyResult.pattern.purity[0] > 0.85,
  `cells=${pureDirtyResult.pattern.cells}; purity=${pureDirtyResult.pattern.purity[0]}`)

const equalAnchors = { ...cleanFillText, legend: { ...cleanFillText.legend,
  anchors: [d1, d6].map((index) => ({ index, rgb: PALETTE[d6].rgb })),
} }
const equalAnchorResult = buildPattern(recoverable.img, recoverable.grid, { ...base, textRecognition: equalAnchors })
check('相同图例RGB的残留像素不能擅自决定真实色号',
  equalAnchorResult.pattern.cells[0] === d1 && equalAnchorResult.calibratedCells === 0 && lowConfidenceCells(equalAnchorResult.pattern).includes(0),
  `cells=${equalAnchorResult.pattern.cells}; calibrated=${equalAnchorResult.calibratedCells}`)
const reliableDirtyText = { ...text([d1]), legend: cleanFillText.legend }
const reliableDirty = buildPattern(recoverable.img, recoverable.grid, { ...base, textRecognition: reliableDirtyText })
check('水印环像素恢复不能覆盖可靠格内文字',
  reliableDirty.pattern.cells[0] === d1 && reliableDirty.calibratedCells === 0,
  `cells=${reliableDirty.pattern.cells}; calibrated=${reliableDirty.calibratedCells}`)

if (checks.some((item) => !item.passed)) throw new Error(JSON.stringify(checks))
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2))
