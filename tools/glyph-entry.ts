import { detectGrid } from '../src/lib/gridDetect'
import {
  extractGlyphs,
  maskToText,
  fillHex,
  clusterChars,
  solveGroups,
  classToText,
  GLYPH_W,
  GLYPH_H,
} from '../src/lib/glyphs'
import { PALETTE, codeOf, indicesInSystem } from '../src/lib/color'

;(window as unknown as Record<string, unknown>).__glyph = {
  detectGrid,
  extractGlyphs,
  maskToText,
  fillHex,
  clusterChars,
  solveGroups,
  classToText,
  GLYPH_W,
  GLYPH_H,
  PALETTE,
  codeOf,
  indicesInSystem,
}
