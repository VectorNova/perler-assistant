import type { GridSpec, RGB } from '../src/types'
import { PALETTE, resolveColorCodes } from '../src/lib/color'
import glyphData from './ocr-fixture-glyphs.json'

/** 独立 Arial 字图生成图例，不调用浏览器字体或应用自身字模。 */
export function independentLegendFixture(options: { labels?: boolean; gridCode?: 'D6' | 'D8' } = {}) {
  const width = 620, height = 440, pitch = 40
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const grid: GridSpec = { offsetX: 40, offsetY: 40, cellW: pitch, cellH: pitch, cols: 8, rows: 4 }
  const index = (code: string) => resolveColorCodes(code, 'MARD').indices[0]
  const fill = (x0: number, y0: number, w: number, h: number, rgb: RGB) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      data.set([...rgb, 255], (y * width + x) * 4)
    }
  }
  const drawText = (code: string, centerX: number, centerY: number) => {
    const font = glyphData.cell as Record<string, { width: number; height: number; alpha: string }>
    const glyphs = Array.from(code, (char) => font[char])
    const textWidth = glyphs.reduce((sum, glyph) => sum + glyph.width, 0) + glyphs.length - 1
    const textHeight = Math.max(...glyphs.map((glyph) => glyph.height))
    let x0 = Math.round(centerX - textWidth / 2)
    const y0 = Math.round(centerY - textHeight / 2)
    for (const glyph of glyphs) {
      const alpha = atob(glyph.alpha)
      for (let y = 0; y < glyph.height; y++) for (let x = 0; x < glyph.width; x++) {
        const a = alpha.charCodeAt(y * glyph.width + x) / 255
        const p = ((y0 + y) * width + x0 + x) * 4
        for (let channel = 0; channel < 3; channel++) data[p + channel] = Math.round(data[p + channel] * (1 - a))
      }
      x0 += glyph.width + 1
    }
  }
  // 图纸填色固定为公共 D6，独立文字可为 D8，制造真实的语义/公共 RGB 分离。
  const gridCode = options.gridCode ?? 'D8'
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
    const x = grid.offsetX + col * pitch, y = grid.offsetY + row * pitch
    fill(x, y, pitch, pitch, PALETTE[index('D6')].rgb)
    drawText(gridCode, x + pitch / 2, y + pitch / 2)
  }
  const codes = ['D1', 'D2', 'D3', 'D4', 'D6']
  const boxes = codes.map((code, col) => {
    const box = { x: 30 + col * 100, y: 270, w: 80, h: 42 }
    fill(box.x - 1, box.y - 1, box.w + 2, box.h + 2, [140, 140, 140])
    fill(box.x, box.y, box.w, box.h, PALETTE[index(code)].rgb)
    // 最后一块始终不印字，补全必须获得格内文字的独立语义支持。
    if (options.labels !== false && col < 4) drawText(code, box.x + box.w / 2, box.y + box.h / 2)
    return box
  })
  return { img: { width, height, data } as ImageData, grid, boxes, truth: index(gridCode), codes }
}
