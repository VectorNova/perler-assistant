import { detectGrid } from '../src/lib/gridDetect'
import { extractGlyphs, maskToText, fillHex, GLYPH_W, GLYPH_H } from '../src/lib/glyphs'

;(window as unknown as Record<string, unknown>).__glyph = {
  detectGrid,
  extractGlyphs,
  maskToText,
  fillHex,
  GLYPH_W,
  GLYPH_H,
}
