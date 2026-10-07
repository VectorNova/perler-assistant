import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const cache = path.resolve('node_modules/.cache/perler-verify')
mkdirSync(cache, { recursive: true })
const outfile = path.join(cache, 'chart-legend.mjs')
await build({ entryPoints: ['src/lib/chartLegend.ts'], bundle: true, platform: 'node', format: 'esm', outfile })

const grid = { offsetX: 10, offsetY: 10, cellW: 20, cellH: 20, cols: 25, rows: 8 }
const colors = [[35, 130, 200], [180, 65, 75], [255, 255, 255], [100, 165, 60], [170, 105, 200], [255, 255, 255]]

function fixture(options = {}) {
  const width = options.width ?? 600, height = options.height ?? 430
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const fill = (x, y, w, h, rgb) => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) {
        const p = (yy * width + xx) * 4
        data[p] = rgb[0]; data[p + 1] = rgb[1]; data[p + 2] = rgb[2]
      }
    }
  }
  const swatch = (x, y, rgb, bordered = true) => {
    if (bordered) fill(x - 1, y - 1, 42, 34, [140, 140, 140])
    fill(x, y, 40, 32, rgb)
    // 少量文字笔画不改变填色中位数。
    fill(x + 15, y + 10, 2, 10, [0, 0, 0])
    fill(x + 15, y + 10, 8, 2, [0, 0, 0])
  }
  // 单色坐标栏也有规则排列，不能当成图例。
  if (!options.noRuler) for (let col = 0; col < 10; col++) fill(20 + col * 50, 177, 40, 24, [3, 169, 244])
  for (let col = 0; col < colors.length; col++) {
    if (options.missing === col) continue
    swatch(20 + col * 50, options.firstY ?? 230, options.allWhiteFirstRow ? [255, 255, 255] : colors[col])
  }
  if (!options.noSecondRow) {
    for (let col = 0; col < 4; col++) swatch(20 + col * 50, 300, colors[col], !options.unborderedWhite || col !== 2)
  }
  if (options.allWhiteLastRow) for (let col = 0; col < 3; col++) swatch(20 + col * 50, 370, [255, 255, 255])
  if (options.clippedLast) swatch(width - 20, 300, [255, 255, 255])
  if (options.watermark) {
    fill(225, 232, 18, 12, [190, 140, 150])
    fill(229, 244, 10, 15, [190, 140, 150])
  }
  return { width, height, data }
}

try {
  const { detectChartLegend } = await import(pathToFileURL(outfile).href)
  const complete = detectChartLegend(fixture(), grid)
  assert.equal(complete?.swatches.length, 10, '白色块以及白色排尾必须完整恢复')
  assert.equal(complete?.layout, 'below')
  assert.ok(complete.confidence >= 0.9)
  assert.deepEqual(complete.swatches[2].rgb, [255, 255, 255])
  assert.equal(detectChartLegend(fixture({ watermark: true }), grid)?.swatches.length, 10, '小水印不能增加色块')
  assert.equal(detectChartLegend(fixture({ missing: 2 }), grid), null, '内部缺边框时拒绝封闭色板')
  assert.equal(detectChartLegend(fixture({ unborderedWhite: true }), grid), null, '无框白块不能凭周期猜测')
  assert.equal(detectChartLegend(fixture({ width: 290 }), grid), null, '右侧裁切到白块时拒绝')
  assert.equal(detectChartLegend(fixture({ height: 325 }), grid), null, '末排下边框裁切时拒绝')
  assert.equal(detectChartLegend(fixture({ allWhiteLastRow: true, height: 460 }), grid), null, '漏掉整排白块时拒绝封闭色板')
  assert.equal(detectChartLegend(fixture({ allWhiteLastRow: true, noSecondRow: true, height: 470 }), grid), null, '仅检测到一排时也应查找遗漏白排')
  assert.equal(detectChartLegend(fixture({ allWhiteFirstRow: true }), grid), null, '遗漏首排全白块时拒绝封闭色板')
  assert.equal(detectChartLegend(fixture({ allWhiteFirstRow: true, noRuler: true, firstY: 176 }), grid), null, '无坐标栏时紧靠网格的白首排也不可漏掉')
  console.log('chart legend geometry: 10 cases passed')
} finally {
  rmSync(outfile, { force: true })
}
