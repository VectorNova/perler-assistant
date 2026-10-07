/** Browser-side production pipeline; expected counts are used only afterwards. */
import { detectGrid } from '../src/lib/gridDetect'
import { buildPattern, derivePlan, blankCount } from '../src/lib/pattern'
import { codeOf, indicesInSystem, type PaletteSystemId } from '../src/lib/color'
import { recognizeChart } from '../src/lib/chartOcr'
import { chartFixtures } from './chart-fixtures'
import type { Pattern } from '../src/types'
import type { ProjectMeta, ProjectPattern } from '../src/lib/projects'

function countsByCode(pattern: Pattern): Record<string, number> {
  return Object.fromEntries(
    [...derivePlan(pattern, new Set()).counts].map(([index, count]) => [codeOf(index, 'MARD'), count]),
  )
}

async function analyzeChart(img: ImageData, system: PaletteSystemId = 'MARD221') {
  const started = performance.now()
  const detected = detectGrid(img)
  const allowed = indicesInSystem(system)
  const options = {
    name: 'chart-verification',
    imageUrl: '',
    imageHash: 'chart-verification',
    dropBackground: true,
    disableRegionConsistency: true,
    allowed,
  }
  const baseline = buildPattern(img, detected.grid, options)
  const recognition = await recognizeChart(img, detected.grid)
  const enhanced = buildPattern(img, detected.grid, { ...options, textRecognition: recognition })
  let changedCells = 0
  for (let i = 0; i < enhanced.pattern.cells.length; i++) {
    if (baseline.pattern.cells[i] !== enhanced.pattern.cells[i]) changedCells++
  }
  return {
    image: { width: img.width, height: img.height },
    grid: detected.grid,
    gridConfidence: detected.confidence,
    gridDebug: detected.debug,
    counts: countsByCode(enhanced.pattern),
    baselineCounts: countsByCode(baseline.pattern),
    changedCells,
    blankCells: blankCount(enhanced.pattern),
    baselineBlankCells: blankCount(baseline.pattern),
    ocr: enhanced.pattern.recognition,
    elapsedMs: Math.round(performance.now() - started),
  }
}

function evaluateChart(report: Awaited<ReturnType<typeof analyzeChart>>, file: string) {
  // Ground truth never enters grid detection, OCR, palette selection, or sampling.
  const fixture = chartFixtures.find((candidate) => candidate.file === file)
  if (!fixture) return { fixture: null, pixelAccuracyVerified: false }
  const differences = (actual: Record<string, number>) => {
    const codes = new Set([...Object.keys(fixture.counts), ...Object.keys(actual)])
    return [...codes]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((code) => ({ code, expected: fixture.counts[code] ?? 0, actual: actual[code] ?? 0 }))
      .filter((value) => value.expected !== value.actual)
  }
  const mismatches = differences(report.counts)
  const baselineMismatches = differences(report.baselineCounts)
  const actualTotal = Object.values(report.counts).reduce((sum, count) => sum + count, 0)
  const geometryErrors = {
    offsetX: Math.abs(report.grid.offsetX - fixture.grid.offsetX),
    offsetY: Math.abs(report.grid.offsetY - fixture.grid.offsetY),
    cellW: Math.abs(report.grid.cellW - fixture.grid.cellW),
    cellH: Math.abs(report.grid.cellH - fixture.grid.cellH),
  }
  const countError = (values: typeof mismatches) =>
    values.reduce((sum, value) => sum + Math.abs(value.actual - value.expected), 0)
  return {
    fixture: fixture.file,
    gridMatches: report.grid.cols === fixture.grid.cols && report.grid.rows === fixture.grid.rows &&
      geometryErrors.offsetX <= 0.5 && geometryErrors.offsetY <= 0.5 &&
      geometryErrors.cellW <= 0.05 && geometryErrors.cellH <= 0.05,
    geometryErrors,
    totalMatches: actualTotal === fixture.total,
    countsMatch: mismatches.length === 0,
    expectedGrid: fixture.grid,
    expectedTotal: fixture.total,
    actualTotal,
    mismatches,
    baselineMismatches,
    countL1Error: countError(mismatches),
    baselineCountL1Error: countError(baselineMismatches),
    // Equal counts can conceal swapped cells. These fixtures are not pixel labels.
    pixelAccuracyVerified: false,
  }
}

function summarizeStoredProject(record: ProjectPattern, meta: ProjectMeta) {
  const plan = derivePlan(record as unknown as Pattern, new Set(meta.settings.excluded), {
    treatBlankAsEmpty: meta.settings.treatBlankAsEmpty,
  })
  const counts = Object.fromEntries([...plan.counts].map(([index, count]) => [codeOf(index, 'MARD'), count]))
  const fingerprint = (array: ArrayBufferView | undefined) => {
    if (!array) return null
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    let hash = 0x811c9dc5
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
    return hash.toString(16)
  }
  return {
    id: record.id,
    image: { width: record.imageW, height: record.imageH },
    grid: record.grid,
    gridConfidence: meta.confidence,
    gridDebug: 'Imported through the app file input and read back from IndexedDB',
    counts,
    baselineCounts: counts,
    changedCells: 0,
    blankCells: record.blank.reduce((sum, value) => sum + (value ? 1 : 0), 0),
    baselineBlankCells: 0,
    ocr: record.recognition!,
    elapsedMs: 0,
    evidence: {
      confidenceLength: record.textConfidence?.length ?? 0,
      confidenceIsFloat32Array: record.textConfidence instanceof Float32Array,
      confidenceValid: !!record.textConfidence?.every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
      confidentCells: record.textConfidence?.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0) ?? 0,
      confidenceHash: fingerprint(record.textConfidence),
      cellsHash: fingerprint(record.cells),
      recognition: record.recognition,
    },
  }
}

;(window as unknown as Record<string, unknown>).__verifyCharts = { analyzeChart, evaluateChart, summarizeStoredProject }
