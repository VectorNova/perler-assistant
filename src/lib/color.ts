import type { Lab, PaletteEntry, RGB } from '../types'
import rawMapping from '../data/colorSystemMapping.json'

type RawMapping = Record<string, Record<string, string>>

const mapping = rawMapping as RawMapping

/* ------------------------------------------------------------------ *
 * 基础色彩转换
 * ------------------------------------------------------------------ */

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

export function rgbToHex(rgb: RGB): string {
  return (
    '#' +
    rgb
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

/** sRGB 分量（0..255）转线性光，用于 XYZ 计算 */
function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

const XN = 0.95047
const YN = 1.0
const ZN = 1.08883
const EPS = 216 / 24389
const KAPPA = 24389 / 27

function labF(t: number): number {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116
}

/** sRGB -> CIELAB (D65) */
export function rgbToLab(rgb: RGB): Lab {
  const r = srgbToLinear(rgb[0])
  const g = srgbToLinear(rgb[1])
  const b = srgbToLinear(rgb[2])

  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN

  const fx = labF(x)
  const fy = labF(y)
  const fz = labF(z)

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const RAD = Math.PI / 180

function hueAngle(b: number, a: number): number {
  if (a === 0 && b === 0) return 0
  const h = Math.atan2(b, a) / RAD
  return h < 0 ? h + 360 : h
}

/**
 * CIEDE2000 色差。比 RGB 欧氏距离更符合人眼感知，
 * 在区分深色系（黑/深灰/深蓝）与低饱和色时明显更准。
 */
export function deltaE2000(l1: Lab, l2: Lab): number {
  const [L1, a1, b1] = l1
  const [L2, a2, b2] = l2

  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cbar = (C1 + C2) / 2
  const Cbar7 = Math.pow(Cbar, 7)
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))))

  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)

  const h1p = hueAngle(b1, a1p)
  const h2p = hueAngle(b2, a2p)

  const dLp = L2 - L1
  const dCp = C2p - C1p

  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * RAD) / 2)

  const Lbarp = (L1 + L2) / 2
  const Cbarp = (C1p + C2p) / 2

  let hbarp: number
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2
  } else if (h1p + h2p < 360) {
    hbarp = (h1p + h2p + 360) / 2
  } else {
    hbarp = (h1p + h2p - 360) / 2
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * RAD) +
    0.24 * Math.cos(2 * hbarp * RAD) +
    0.32 * Math.cos((3 * hbarp + 6) * RAD) -
    0.2 * Math.cos((4 * hbarp - 63) * RAD)

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2))
  const Cbarp7 = Math.pow(Cbarp, 7)
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)))
  const Lm50 = Math.pow(Lbarp - 50, 2)
  const SL = 1 + (0.015 * Lm50) / Math.sqrt(20 + Lm50)
  const SC = 1 + 0.045 * Cbarp
  const SH = 1 + 0.015 * Cbarp * T
  const RT = -Math.sin(2 * dTheta * RAD) * RC

  return Math.sqrt(
    Math.pow(dLp / SL, 2) +
      Math.pow(dCp / SC, 2) +
      Math.pow(dHp / SH, 2) +
      RT * (dCp / SC) * (dHp / SH),
  )
}

/* ------------------------------------------------------------------ *
 * 调色板
 * ------------------------------------------------------------------ */

function buildPalette(): PaletteEntry[] {
  const list: PaletteEntry[] = []
  for (const [hex, keys] of Object.entries(mapping)) {
    const norm = hex.toUpperCase()
    const rgb = hexToRgb(norm)
    list.push({
      hex: norm,
      rgb,
      lab: rgbToLab(rgb),
      keys: {
        MARD: keys.MARD ?? '?',
        COCO: keys.COCO ?? '?',
        漫漫: keys['漫漫'] ?? '?',
        盼盼: keys['盼盼'] ?? '?',
        咪小窝: keys['咪小窝'] ?? '?',
      },
    })
  }
  // 稳定排序：先按 MARD 色号的字母 + 数字
  list.sort((a, b) => a.keys.MARD.localeCompare(b.keys.MARD, 'en', { numeric: true }))
  return list
}

/** 291 种标准拼豆色（Zippland/perler-beads 的 colorSystemMapping.json） */
export const PALETTE: PaletteEntry[] = buildPalette()

/** hex -> 调色板下标，用于精确命中（图纸通常是纯色填充，能直接命中） */
export const HEX_TO_INDEX = new Map<string, number>(
  PALETTE.map((p, i) => [p.hex, i]),
)

const exactCache = new Map<number, number>()

function quantKey(rgb: RGB): number {
  return ((rgb[0] >> 3) << 10) | ((rgb[1] >> 3) << 5) | (rgb[2] >> 3)
}

/**
 * 找到最接近的调色板颜色下标。
 * 1) 先试精确 hex 命中（图纸导出通常是纯色，命中率极高）
 * 2) 否则用 CIEDE2000 在 LAB 空间找最近色，并按量化键缓存结果
 */
export function nearestPaletteIndex(rgb: RGB): number {
  const exact = HEX_TO_INDEX.get(rgbToHex(rgb))
  if (exact !== undefined) return exact

  const key = quantKey(rgb)
  const cached = exactCache.get(key)
  if (cached !== undefined) return cached

  const lab = rgbToLab(rgb)
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < PALETTE.length; i++) {
    const d = deltaE2000(lab, PALETTE[i].lab)
    if (d < bestD) {
      bestD = d
      best = i
      if (d === 0) break
    }
  }
  exactCache.set(key, best)
  return best
}

/**
 * 在给定的候选下标子集里找最近色（用于「排除某颜色后重映射到最近可用色」）。
 * 候选集合很小，无需缓存。
 */
export function nearestAmong(rgb: RGB, candidates: number[]): number {
  if (candidates.length === 0) return PALETTE.length // 无效
  const lab = rgbToLab(rgb)
  let best = candidates[0]
  let bestD = Infinity
  for (const idx of candidates) {
    const d = deltaE2000(lab, PALETTE[idx].lab)
    if (d < bestD) {
      bestD = d
      best = idx
    }
  }
  return best
}

/**
 * 在给定候选子集里找最近色，并返回色差。
 * 用来实现「按图纸图例约束色板」：图纸底部的色号表列出了这张图纸真正用到的
 * 颜色，把匹配范围收窄到这些颜色，能大幅减少「认成相邻色号」的噪声。
 */
export function nearestAmongWithDistance(
  rgb: RGB,
  candidates: number[],
): { index: number; delta: number } {
  if (candidates.length === 0) return { index: PALETTE.length, delta: Infinity }
  const lab = rgbToLab(rgb)
  let best = candidates[0]
  let bestD = Infinity
  for (const idx of candidates) {
    const d = deltaE2000(lab, PALETTE[idx].lab)
    if (d < bestD) {
      bestD = d
      best = idx
    }
  }
  return { index: best, delta: bestD }
}

/* ------------------------------------------------------------------ *
 * 色号 → 调色板下标
 * 同一张图纸可能用任一品牌体系标注，所以把 5 个体系的色号都索引进来。
 * 数字型色号（盼盼 / 咪小窝）会天然指向多个候选，这是可以接受的 ——
 * 候选多一些只是约束弱一点，不会引入错误。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 色号的规范化与显示格式
 *
 * 显示：去掉数字部分的前导零 —— D01 → D1、H07 → H7、A01 → A1。
 *       字母前缀和纯数字都不受影响（C10 → C10、ZG1 → ZG1、65 → 65）。
 *
 * 匹配：规范化后的形式同时用于「查表」和「显示」，
 *       所以用户粘图纸上印的 C07、还是手打成 C7，都能认出来。
 * ------------------------------------------------------------------ */

const CODE_RE = /^([A-Z]*)(\d+)$/

/** 去掉数字部分的前导零；不是「字母+数字」形式的原样返回 */
export function formatColorCode(code: string): string {
  const t = code.trim().toUpperCase()
  const m = CODE_RE.exec(t)
  if (!m) return t
  const n = parseInt(m[2], 10)
  return `${m[1]}${Number.isFinite(n) ? n : m[2]}`
}

const ALL_BRANDS = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝'] as const

/** 色号 → 调色板下标，按品牌分开索引（同名色号在不同品牌是完全不同的颜色） */
const CODE_INDEX_BY_BRAND: Map<string, Map<string, number>> = (() => {
  const out = new Map<string, Map<string, number>>()
  for (const brand of ALL_BRANDS) out.set(brand, new Map())
  PALETTE.forEach((p, i) => {
    for (const brand of ALL_BRANDS) {
      const code = p.keys[brand]
      if (!code || code === '?' || code === '-') continue
      const m = out.get(brand) as Map<string, number>
      const key = formatColorCode(code)
      if (!m.has(key)) m.set(key, i)
    }
  })
  return out
})()

/**
 * 把一串色号（来自图纸图例、用户手输或视觉模型识别）解析成调色板下标集合。
 *
 * 一定要指定品牌：同一个色号在不同品牌里是完全不同的颜色
 * （MARD 的 A06 和 COCO 的 A06 不是一回事），
 * 不分品牌会把候选集撑大一倍以上，还可能把格子吸到别的品牌的颜色上。
 *
 * 支持空格、逗号、顿号、分号、竖线、斜杠分隔；C07 与 C7 等价。
 * 返回在指定品牌里找不到的色号，方便提示用户别是看错了。
 */
export function resolveColorCodes(
  text: string,
  brand: import('../types').Brand = 'MARD',
): { indices: number[]; unknown: string[]; crossBrand: string[] } {
  const tokens = text
    .split(/[\s,，、;；|/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  const primary = CODE_INDEX_BY_BRAND.get(brand) ?? new Map<string, number>()
  const set = new Set<number>()
  const unknown: string[] = []
  const crossBrand: string[] = []
  for (const t of tokens) {
    const key = formatColorCode(t)
    const hit = primary.get(key)
    if (hit !== undefined) {
      set.add(hit)
      continue
    }
    // 指定品牌里没有 → 去别的品牌找，找到就记下来提示用户
    let foundOther = false
    for (const b of ALL_BRANDS) {
      if (b === brand) continue
      const idx = CODE_INDEX_BY_BRAND.get(b)?.get(key)
      if (idx !== undefined) {
        set.add(idx)
        foundOther = true
      }
    }
    if (foundOther) crossBrand.push(t)
    else unknown.push(t)
  }
  return { indices: [...set].sort((a, b) => a - b), unknown, crossBrand }
}

/** 该色号是否存在于任意品牌体系中（C07 / C7 等价） */
export function isKnownColorCode(code: string): boolean {
  const key = formatColorCode(code)
  for (const m of CODE_INDEX_BY_BRAND.values()) if (m.has(key)) return true
  return false
}

/**
 * 取色号（用于显示）；找不到则回落到 '?'。
 *
 * 这是整个界面和导出的唯一出口，所以「不补前导零」只在这里做一次：
 * D01 → D1、H07 → H7，列表、指引面板、画布格内文字、CSV/图导出一致。
 */
export function codeOf(paletteIndex: number, brand: import('../types').Brand): string {
  const entry = PALETTE[paletteIndex]
  if (!entry) return '?'
  const k = entry.keys[brand]
  return k && k.length > 0 ? formatColorCode(k) : '?'
}

/** 文字颜色：在给定底色上用黑还是白更清楚 */
export function readableTextColor(rgb: RGB): string {
  // 相对亮度（WCAG）
  const lin = rgb.map((c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
  return L > 0.42 ? '#111' : '#fff'
}

export function contrastRatio(a: RGB, b: RGB): number {
  const lum = (rgb: RGB) => {
    const lin = rgb.map((c) => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
  }
  const la = lum(a)
  const lb = lum(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
