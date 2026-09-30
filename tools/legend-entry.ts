import { detectLegendSwatches, drawLegendDebug, patternBottom } from '../src/lib/legend'
import type { Brand } from '../src/types'

// 挂到 window 上供 CDP 工具调用（esbuild 打成 IIFE）
;(window as unknown as Record<string, unknown>).__legend = {
  detectLegendSwatches,
  drawLegendDebug,
  patternBottom,
  type: 'ok' as Brand | string,
}
