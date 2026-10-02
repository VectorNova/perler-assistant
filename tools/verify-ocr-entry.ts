import { recognizeChart } from '../src/lib/chartOcr'
import { codeOf } from '../src/lib/color'
import { buildPattern, CELL_TEXT_CONFLICT, CELL_TEXT_UNCERTAIN } from '../src/lib/pattern'
import { independentOcrFixture } from './ocr-fixture'

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = []
const staticOnly = new URLSearchParams(location.search).has('static')
if (staticOnly) {
  Object.defineProperty(globalThis, 'OffscreenCanvas', { value: undefined, configurable: true })
  const createElement = document.createElement.bind(document)
  document.createElement = ((tag: string) => tag === 'canvas' ? null : createElement(tag)) as typeof document.createElement
}
const numbered = independentOcrFixture(true)
const numberedResult = recognizeChart(numbered.img, numbered.grid)
const matched = Array.from(numbered.truth).filter((truth, i) => numberedResult.indices[i] === truth).length
checks.push({
  name: '独立 Arial 字图：D6/D8 逐格识别',
  ok: matched === numbered.truth.length && numberedResult.summary.learnedDigits === 10,
  detail: `${matched}/${numbered.truth.length} 格与独立真值一致；标尺学习 ${numberedResult.summary.learnedDigits} 个数字`,
})
const counts = Array.from(numberedResult.indices).reduce((map, index) => {
  const code = index < 0 ? '?' : codeOf(index, 'MARD')
  map[code] = (map[code] ?? 0) + 1
  return map
}, {} as Record<string, number>)
checks.push({
  name: '相同 RGB 的不同文字色号保留各自身份',
  ok: counts.D6 === 200 && counts.D8 === 200,
  detail: JSON.stringify(counts),
})

const unnumbered = independentOcrFixture(false)
const unnumberedResult = recognizeChart(unnumbered.img, unnumbered.grid)
const unnumberedMatched = Array.from(unnumbered.truth).filter((truth, i) => unnumberedResult.indices[i] === truth).length
checks.push({
  name: '无坐标栏时使用已知字体语义，不编造标尺监督',
  ok: unnumberedResult.summary.learnedDigits === 0 && unnumberedMatched === unnumbered.truth.length,
  detail: `${unnumberedMatched}/${unnumbered.truth.length} 格；标尺学习 ${unnumberedResult.summary.learnedDigits} 个数字`,
})

const illegal = independentOcrFixture(true, { exceptionalCell: 0 })
const illegalResult = recognizeChart(illegal.img, illegal.grid)
checks.push({
  name: '非法 X8 文字保留未知状态，合法码词表不能强塞答案',
  ok: illegalResult.indices[0] === -1 && illegalResult.hasText[0] === 1,
  detail: `输出 ${illegalResult.indices[0] < 0 ? '?' : codeOf(illegalResult.indices[0], 'MARD')}，confidence=${illegalResult.confidence[0]}`,
})

const majority = independentOcrFixture(true, { exceptionalCell: 0, uniformCode: 'D6' })
const majorityResult = recognizeChart(majority.img, majority.grid)
checks.push({
  name: '多数同色文字不能覆盖一个明确陌生的字形',
  ok: majorityResult.indices[0] === -1 && majorityResult.hasText[0] === 1,
  detail: `399格 D6 + 1格 X8，同 RGB；X8 输出 ${majorityResult.indices[0] < 0 ? '?' : codeOf(majorityResult.indices[0], 'MARD')}，confidence=${majorityResult.confidence[0]}`,
})

// 21px is absent from the static font asset. Raster differences may reduce recall,
// but the recognizer must retain uncertainty rather than confidently swap 8 to 6.
const holdout = independentOcrFixture(true, { font: 'holdout' })
const holdoutResult = recognizeChart(holdout.img, holdout.grid)
const holdoutWrong = Array.from(holdoutResult.indices).filter((index, i) => index >= 0 && index !== holdout.truth[i]).length
checks.push({
  name: '未见过的字号可保留未知，不能产生高置信错号',
  ok: holdoutWrong === 0 && holdoutResult.summary.textCells === holdout.truth.length,
  detail: `21px：错号 ${holdoutWrong}，采信 ${holdoutResult.summary.recognizedCells}，待确认 ${holdoutResult.summary.unresolvedCells}`,
})

const weakMinority = independentOcrFixture(true, {
  uniformCode: 'D6', exceptionalCell: 0, exceptionalCode: 'D8', exceptionalFont: 'holdout', exceptionalDigitBlend: 0.15,
})
const weakAlone = recognizeChart(weakMinority.img, { ...weakMinority.grid, cols: 1, rows: 1 })
const weakMinorityResult = recognizeChart(weakMinority.img, weakMinority.grid)
checks.push({
  name: '多数 D6 不能覆盖一个弱但指向 D8 的格子',
  ok: [weakAlone, weakMinorityResult].every((result) => result.indices[0] === -1 || result.indices[0] === weakMinority.truth[0]),
  detail: `单格输出 ${weakAlone.indices[0] < 0 ? '?' : codeOf(weakAlone.indices[0], 'MARD')}；399格 D6 同 RGB 多数后输出 ${weakMinorityResult.indices[0] < 0 ? '?' : codeOf(weakMinorityResult.indices[0], 'MARD')}，confidence=${weakMinorityResult.confidence[0]}`,
})

const onlyD6 = [weakMinority.truth[1]]
const weakConstrained = buildPattern(weakMinority.img, { ...weakMinority.grid, cols: 1, rows: 1 }, {
  name: 'weak constrained glyph', imageUrl: '', imageHash: 'weak', dropBackground: true,
  allowed: onlyD6, textRecognition: weakAlone,
}).pattern
checks.push({
  name: '手工只允许 D6 时仍保留弱 D8 的不确定性',
  ok: weakAlone.indices[0] === -1 && (weakConstrained.flags![0] & CELL_TEXT_UNCERTAIN) !== 0,
  detail: `字符输出 ${weakAlone.indices[0]}，颜色候选 ${codeOf(weakConstrained.cells[0], 'MARD')}，flags=${weakConstrained.flags![0]}`,
})
const strongGrid = { ...numbered.grid, offsetX: numbered.grid.offsetX + numbered.grid.cellW, cols: 1, rows: 1 }
const strongD8 = recognizeChart(numbered.img, strongGrid)
const strongConstrained = buildPattern(numbered.img, strongGrid, {
  name: 'strong constrained glyph', imageUrl: '', imageHash: 'strong', dropBackground: true,
  allowed: onlyD6, textRecognition: strongD8,
}).pattern
checks.push({
  name: '手工图例排除实际 D8 时保留字符冲突证据',
  ok: strongD8.indices[0] === numbered.truth[1] && (strongConstrained.flags![0] & CELL_TEXT_CONFLICT) !== 0,
  detail: `字符 ${codeOf(strongD8.indices[0], 'MARD')}，颜色候选 ${codeOf(strongConstrained.cells[0], 'MARD')}，flags=${strongConstrained.flags![0]}`,
})
const output = document.getElementById('result')!
output.textContent = JSON.stringify({ staticOnly, checks, ok: checks.every((check) => check.ok) })
