import type {
  Brand,
  CellOrderMode,
  ColorOrderMode,
  GridSpec,
  Pattern,
  RegionOrderMode,
} from '../types'

const KEY = 'perler-assistant/session/v1'

export interface StoredSession {
  version: 1
  imageHash: string
  name: string
  imageW: number
  imageH: number
  grid: GridSpec
  /** base64(Int16Array) —— 图纸识别结果，体积很小，无需保存原图即可恢复视图 */
  cells: string
  /** base64 位图 —— 自动识别的空白格掩码 */
  blank: string
  pageBg: [number, number, number]
  brand: Brand
  excluded: number[]
  /** base64 位图，标记已拼完的格子 */
  done: string
  colorOrder: ColorOrderMode
  cellOrder: CellOrderMode
  regionOrder?: RegionOrderMode
  createdAt: number
  updatedAt: number
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function i16ToBase64(arr: Int16Array): string {
  return bytesToBase64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength))
}

function base64ToI16(b64: string, expected: number): Int16Array {
  const out = new Int16Array(expected)
  const bytes = base64ToBytes(b64)
  const avail = Math.min(expected, bytes.byteLength >> 1)
  const src = new Int16Array(bytes.buffer, bytes.byteOffset, avail)
  out.set(src)
  return out
}

export function encodeBitset(flags: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(flags.length / 8))
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) bytes[i >> 3] |= 1 << (i & 7)
  }
  return bytesToBase64(bytes)
}

export function decodeBitset(b64: string, n: number): Uint8Array {
  const out = new Uint8Array(n)
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(b64)
  } catch {
    return out
  }
  for (let i = 0; i < n; i++) {
    const b = bytes[i >> 3]
    if (b === undefined) break
    if (b & (1 << (i & 7))) out[i] = 1
  }
  return out
}

export function usedBytes(): number {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? raw.length : 0
  } catch {
    return 0
  }
}

/** 保存会话；超出 localStorage 配额时返回错误信息 */
export function saveSession(session: StoredSession): { ok: boolean; error?: string } {
  try {
    localStorage.setItem(KEY, JSON.stringify(session))
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredSession
    if (!parsed || parsed.version !== 1 || !parsed.cells || !parsed.grid) return null
    return parsed
  } catch {
    return null
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

export function patternFromSession(s: StoredSession): Pattern {
  const n = s.grid.cols * s.grid.rows
  const cells = base64ToI16(s.cells, n)
  const blank = s.blank ? decodeBitset(s.blank, n) : new Uint8Array(n)
  return {
    id: s.imageHash,
    name: s.name,
    imageW: s.imageW,
    imageH: s.imageH,
    grid: { ...s.grid },
    cells,
    blank,
    purity: new Float32Array(n).fill(1),
    pageBg: s.pageBg,
    imageUrl: '',
    createdAt: s.createdAt,
  }
}

export function sessionFromPattern(
  pattern: Pattern,
  extra: {
    imageHash: string
    brand: Brand
    excluded: number[]
    done: Uint8Array
    colorOrder: ColorOrderMode
    cellOrder: CellOrderMode
    regionOrder: RegionOrderMode
  },
): StoredSession {
  return {
    version: 1,
    imageHash: extra.imageHash,
    name: pattern.name,
    imageW: pattern.imageW,
    imageH: pattern.imageH,
    grid: { ...pattern.grid },
    cells: i16ToBase64(pattern.cells),
    blank: encodeBitset(pattern.blank),
    pageBg: pattern.pageBg,
    brand: extra.brand,
    excluded: extra.excluded,
    done: encodeBitset(extra.done),
    colorOrder: extra.colorOrder,
    cellOrder: extra.cellOrder,
    regionOrder: extra.regionOrder,
    createdAt: pattern.createdAt,
    updatedAt: Date.now(),
  }
}

/** 把完成标记导出为可分享/备份的紧凑文本 */
export function exportProgressText(session: StoredSession): string {
  return JSON.stringify(
    {
      app: 'perler-assistant',
      version: 1,
      imageHash: session.imageHash,
      grid: session.grid,
      cells: session.cells,
      done: session.done,
    },
    null,
    0,
  )
}

export function importProgressText(text: string): StoredSession | null {
  try {
    const parsed = JSON.parse(text) as Partial<StoredSession> & { app?: string }
    if (parsed.app !== 'perler-assistant') return null
    if (!parsed.cells || !parsed.grid || !parsed.done) return null
    return {
      version: 1,
      imageHash: parsed.imageHash ?? 'imported',
      name: parsed.name ?? '导入的进度',
      imageW: parsed.imageW ?? 0,
      imageH: parsed.imageH ?? 0,
      grid: parsed.grid,
      cells: parsed.cells,
      blank: parsed.blank ?? '',
      pageBg: parsed.pageBg ?? [255, 255, 255],
      brand: parsed.brand ?? 'MARD',
      excluded: parsed.excluded ?? [],
      done: parsed.done,
      colorOrder: parsed.colorOrder ?? 'countDesc',
      cellOrder: parsed.cellOrder === 'row' || parsed.cellOrder === 'nearest' ? parsed.cellOrder : 'snake',
      regionOrder: parsed.regionOrder ?? 'flow',
      createdAt: parsed.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    }
  } catch {
    return null
  }
}
