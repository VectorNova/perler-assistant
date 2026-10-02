import { EMPTY, type Brand, type DimMode, type GridSpec, type OrderOptions, type RGB, type RecognitionSummary } from '../types'
import { PALETTE } from './color'

/* ------------------------------------------------------------------ *
 * 项目管理存储（IndexedDB）
 *
 * 为什么不用 localStorage：
 *  - 要保存图纸原图（几百 KB 的 JPEG），localStorage 只有 ~5MB 且只能存字符串，
 *    base64 还会再胖 33%；IndexedDB 能直接存 Blob。
 *  - localStorage 存 TypedArray 必须先 base64，IndexedDB 可以结构化克隆直接存。
 *
 * 为什么拆成 4 个 store：
 *  首页只需要「列出项目」，如果把识别数据（cells + purity，一张 104×104 的图
 *  约 70KB）和原图都塞在一条记录里，列 20 个项目就要反序列化 1.4MB+。
 *  拆开之后首页只读很小的 meta，打开项目时才读 pattern / progress / image。
 *
 *   projects  —— 列表用的元信息 + 全部显示参数（含缩略图 dataURL）
 *   patterns  —— 识别结果（grid / cells / blank / purity）
 *   progress  —— 已完成标记（每次点格子都要写，单独放开销最小）
 *   images    —— 图纸原图 Blob（用于缩略图、重新校准）
 * ------------------------------------------------------------------ */

const DB_NAME = 'perler-assistant'
const DB_VERSION = 1
const S_META = 'projects'
const S_PATTERN = 'patterns'
const S_PROGRESS = 'progress'
const S_IMAGES = 'images'

export type ProjectStatus = 'active' | 'done' | 'failed'

export interface ProjectSettings {
  brand: Brand
  orderOpts: OrderOptions
  excluded: number[]
  /** 图纸图例色号原文（原样保留，方便下次继续编辑） */
  codeText: string
  allowedIndices: number[] | null
  /**
   * 色号体系。MARD 有 221 和 291 两套（291 是 221 的扩展，多出 P/Q/R/T/Y/ZG 共 70 色）。
   * 图纸属于哪套必须跟着项目存 —— 否则重新识别时放错候选集，
   * 又会冒出图纸里根本不存在的色号（用户报的 P1、R8 就是这个问题）。
   * 可选是因为旧项目里没有这个字段，读到时按 221 兜底。
   */
  paletteSystem?: 'MARD221' | 'MARD291'
  treatBlankAsEmpty: boolean
  dimMode: DimMode
  showGrid: boolean
  showCodes: boolean
  showSectionLines: boolean
  sectionInterval: number
  showExcluded: boolean
  showLowConf: boolean
}

/** 识别结果（重的那部分） */
export interface ProjectPattern {
  id: string
  imageHash: string
  imageName: string
  imageW: number
  imageH: number
  grid: GridSpec
  cells: Int16Array
  blank: Uint8Array
  purity: Float32Array
  /**
   * 识别证据：每格的第二候选色号、第一二候选的色差差距、问题标记位。
   * 见 types.ts 的说明。可选是因为旧项目里没有这三个字段，
   * 读到时界面需要降级处理（只剩 purity 可用）。
   */
  second?: Int16Array
  margin?: Float32Array
  flags?: Uint8Array
  textConfidence?: Float32Array
  recognition?: RecognitionSummary
  pageBg: RGB
}

/** 首页列表用的元信息（刻意保持很小） */
export interface ProjectMeta {
  id: string
  name: string
  status: ProjectStatus
  createdAt: number
  updatedAt: number
  cols: number
  rows: number
  doneCount: number
  total: number
  colorCount: number
  blankCount: number
  /** 识别置信度（0..1），用来提示「这个项目可能是识别失败的那个」 */
  confidence: number
  imageName: string
  /** 小缩略图 dataURL */
  thumb: string | null
  settings: ProjectSettings
}

export interface ProjectSummary extends ProjectMeta {
  percent: number
}

/* ----------------------------- IDB 基础 ----------------------------- */

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(S_META)) db.createObjectStore(S_META, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(S_PATTERN)) db.createObjectStore(S_PATTERN, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(S_PROGRESS)) db.createObjectStore(S_PROGRESS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(S_IMAGES)) db.createObjectStore(S_IMAGES, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('打开数据库失败'))
  })
  return dbPromise
}

function tx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(stores, mode)
        let result: T
        let settled = false
        t.oncomplete = () => {
          if (!settled) {
            settled = true
            resolve(result)
          }
        }
        t.onerror = () => {
          if (!settled) {
            settled = true
            reject(t.error ?? new Error('数据库事务失败'))
          }
        }
        t.onabort = () => {
          if (!settled) {
            settled = true
            reject(t.error ?? new Error('数据库事务被中止'))
          }
        }
        Promise.resolve(fn(t)).then(
          (r) => {
            result = r
          },
          (e) => {
            if (!settled) {
              settled = true
              reject(e)
            }
          },
        )
      }),
  )
}

function reqOf<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('请求失败'))
  })
}

/* ----------------------------- 工具 ----------------------------- */

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 用**识别结果**渲染项目封面（不是原图缩略图）。
 *
 * 为什么不用上传图纸的缩略图：
 *  - 原图上带着网格线、格内色号和红色分区线，缩到 84px 就是一团糊，认不出是哪张图；
 *  - 原图缩略图依赖 Blob 解码，一旦失败（或旧版本迁移过来的项目根本没有原图）
 *    卡片就只能显示「无缩略图」；
 *  - 从 cells 渲染出来的就是「拼完的样子」：纯色块、无网格线、无色号、无分区线，
 *    一眼就能认出是哪个图案，而且完全不依赖原图。
 *
 * 做法：先按 1 像素 1 格画一张 cols×rows 的小图，再缩放绘制一次拿到抗锯齿的成品。
 */
export function patternThumbDataUrl(
  cells: Int16Array | ArrayLike<number>,
  cols: number,
  rows: number,
  max = 216,
  background: RGB = [246, 247, 249],
): string | null {
  try {
    if (typeof document === 'undefined' || cols < 1 || rows < 1) return null
    const src = document.createElement('canvas')
    src.width = cols
    src.height = rows
    const sctx = src.getContext('2d')
    if (!sctx) return null

    const img = sctx.createImageData(cols, rows)
    const d = img.data
    const n = Math.min(cols * rows, cells.length)
    for (let i = 0; i < n; i++) {
      const v = cells[i]
      const p = i * 4
      if (v === EMPTY || !(v >= 0) || v >= PALETTE.length) {
        d[p] = background[0]
        d[p + 1] = background[1]
        d[p + 2] = background[2]
      } else {
        const rgb = PALETTE[v].rgb
        d[p] = rgb[0]
        d[p + 1] = rgb[1]
        d[p + 2] = rgb[2]
      }
      d[p + 3] = 255
    }
    sctx.putImageData(img, 0, 0)

    const k = Math.min(1, max / Math.max(cols, rows))
    const w = Math.max(1, Math.round(cols * k))
    const h = Math.max(1, Math.round(rows * k))
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const octx = out.getContext('2d')
    if (!octx) return null
    octx.imageSmoothingEnabled = true
    octx.imageSmoothingQuality = 'high'
    octx.drawImage(src, 0, 0, w, h)
    return out.toDataURL('image/png')
  } catch {
    return null
  }
}

/** 豆子总数：非空格、非自动空白、且颜色没被排除 */
export function beadTotal(
  cells: Int16Array | ArrayLike<number>,
  blank: Uint8Array | ArrayLike<number>,
  excluded: Iterable<number>,
): number {
  const ex = new Set(excluded)
  let n = 0
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i]
    if (v === EMPTY || !v || v < 0) continue
    if (blank[i]) continue
    if (ex.has(v)) continue
    n++
  }
  return n
}

export function doneTotal(
  done: Uint8Array | ArrayLike<number>,
  cells: Int16Array | ArrayLike<number>,
  blank: Uint8Array | ArrayLike<number>,
  excluded: Iterable<number>,
): number {
  const ex = new Set(excluded)
  let n = 0
  for (let i = 0; i < cells.length; i++) {
    if (!done[i]) continue
    const v = cells[i]
    if (v === EMPTY || !v || v < 0) continue
    if (blank[i]) continue
    if (ex.has(v)) continue
    n++
  }
  return n
}

export function countColors(cells: Int16Array | ArrayLike<number>, blank?: Uint8Array): number {
  const seen = new Set<number>()
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i]
    if (v === EMPTY || !v || v < 0) continue
    if (blank && blank[i]) continue
    seen.add(v)
  }
  return seen.size
}

export function countBlank(blank: Uint8Array | ArrayLike<number>): number {
  let n = 0
  for (let i = 0; i < blank.length; i++) if (blank[i]) n++
  return n
}

/* ----------------------------- 读写 ----------------------------- */

/**
 * 原子地改 meta。
 *
 * 必须把「读」和「写」放进同一个 readwrite 事务里。
 * 之前是 `await getProjectMeta(id)` 再开一个事务写 —— 两次分开的事务之间，
 * 别的更新（比如参数防抖保存、进度防抖保存、色板约束重识别）也会读同一份旧值，
 * 后写的那个就把先写的改动整片覆盖掉。
 * 实测症状：应用色号约束后项目里颜色数已经是 32，但首页卡片还显示 53。
 */
async function updateMeta(
  id: string,
  fn: (m: ProjectMeta) => ProjectMeta | null,
): Promise<ProjectMeta | null> {
  let result: ProjectMeta | null = null
  await tx([S_META], 'readwrite', async (t) => {
    const store = t.objectStore(S_META)
    const cur = await reqOf(store.get(id) as IDBRequest<ProjectMeta | undefined>)
    if (!cur) return
    const next = fn(cur)
    if (!next) return
    store.put(next)
    result = next
  })
  return result
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const rows = await tx([S_META], 'readonly', (t) =>
    reqOf(t.objectStore(S_META).getAll() as IDBRequest<ProjectMeta[]>),
  )
  const out: ProjectSummary[] = (rows ?? []).map((m) => ({
    ...m,
    percent: m.total > 0 ? Math.min(100, (m.doneCount / m.total) * 100) : 0,
  }))
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

export async function getProjectPattern(id: string): Promise<ProjectPattern | null> {
  const r = await tx([S_PATTERN], 'readonly', (t) =>
    reqOf(t.objectStore(S_PATTERN).get(id) as IDBRequest<ProjectPattern | undefined>),
  )
  return r ?? null
}

export async function getProjectProgress(id: string): Promise<Uint8Array | null> {
  const r = await tx([S_PROGRESS], 'readonly', (t) =>
    reqOf(t.objectStore(S_PROGRESS).get(id) as IDBRequest<{ id: string; done: Uint8Array } | undefined>),
  )
  return r?.done ?? null
}

export async function getProjectImage(id: string): Promise<Blob | null> {
  const r = await tx([S_IMAGES], 'readonly', (t) =>
    reqOf(t.objectStore(S_IMAGES).get(id) as IDBRequest<{ id: string; blob: Blob } | undefined>),
  )
  return r?.blob ?? null
}

export async function getProjectMeta(id: string): Promise<ProjectMeta | null> {
  const r = await tx([S_META], 'readonly', (t) =>
    reqOf(t.objectStore(S_META).get(id) as IDBRequest<ProjectMeta | undefined>),
  )
  return r ?? null
}

export interface CreateProjectInput {
  name: string
  pattern: ProjectPattern
  settings: ProjectSettings
  done?: Uint8Array
  image: Blob | null
  thumb: string | null
  confidence: number
}

/** 新建项目；返回新项目的 id */
export async function createProject(input: CreateProjectInput): Promise<string> {
  const id = input.pattern.id
  const now = Date.now()
  const blank = input.pattern.blank
  const meta: ProjectMeta = {
    id,
    name: input.name,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    cols: input.pattern.grid.cols,
    rows: input.pattern.grid.rows,
    doneCount: 0,
    total: beadTotal(input.pattern.cells, blank, input.settings.excluded),
    colorCount: countColors(input.pattern.cells, blank),
    blankCount: countBlank(blank),
    confidence: input.confidence,
    imageName: input.pattern.imageName,
    thumb: input.thumb,
    settings: input.settings,
  }
  const n = input.pattern.cells.length
  const done = input.done && input.done.length === n ? input.done : new Uint8Array(n)
  meta.doneCount = doneTotal(done, input.pattern.cells, blank, input.settings.excluded)
  meta.status = meta.total > 0 && meta.doneCount >= meta.total ? 'done' : 'active'

  await tx([S_META, S_PATTERN, S_PROGRESS, S_IMAGES], 'readwrite', async (t) => {
    t.objectStore(S_META).put(meta)
    t.objectStore(S_PATTERN).put(input.pattern)
    t.objectStore(S_PROGRESS).put({ id, done })
    if (input.image) t.objectStore(S_IMAGES).put({ id, blob: input.image })
    else t.objectStore(S_IMAGES).delete(id)
  })
  return id
}

/** 覆盖已有项目的识别结果（重新校准 / 重新应用色板约束后调用） */
export async function replaceProjectPattern(
  id: string,
  pattern: ProjectPattern,
  settings: ProjectSettings,
  confidence: number,
  keepDone: boolean,
  thumb?: string | null,
): Promise<void> {
  const n = pattern.cells.length
  const blank = pattern.blank

  await tx([S_META, S_PATTERN, S_PROGRESS], 'readwrite', async (t) => {
    const metaStore = t.objectStore(S_META)
    const progStore = t.objectStore(S_PROGRESS)

    // 读和写都在同一个事务里，避免并发更新互相覆盖
    const prev = await reqOf(metaStore.get(id) as IDBRequest<ProjectMeta | undefined>)
    const oldRow = keepDone
      ? await reqOf(progStore.get(id) as IDBRequest<{ id: string; done: Uint8Array } | undefined>)
      : undefined

    const done = new Uint8Array(n)
    if (oldRow?.done && oldRow.done.length === n) done.set(oldRow.done)

    const merged: ProjectMeta = {
      id,
      name: prev?.name ?? '项目',
      status: prev?.status ?? 'active',
      createdAt: prev?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      cols: pattern.grid.cols,
      rows: pattern.grid.rows,
      doneCount: 0,
      total: beadTotal(pattern.cells, blank, settings.excluded),
      colorCount: countColors(pattern.cells, blank),
      blankCount: countBlank(blank),
      confidence,
      imageName: pattern.imageName,
      thumb: thumb !== undefined ? thumb : (prev?.thumb ?? null),
      settings,
    }
    merged.doneCount = doneTotal(done, pattern.cells, blank, settings.excluded)
    if (merged.total > 0 && merged.doneCount >= merged.total) merged.status = 'done'
    else if (merged.status === 'done') merged.status = 'active'

    metaStore.put(merged)
    t.objectStore(S_PATTERN).put(pattern)
    progStore.put({ id, done })
  })
}

export async function saveProjectImage(id: string, image: Blob | null): Promise<void> {
  await tx([S_IMAGES], 'readwrite', (t) => {
    if (image) t.objectStore(S_IMAGES).put({ id, blob: image })
    else t.objectStore(S_IMAGES).delete(id)
  })
}

export async function updateProjectThumb(id: string, thumb: string | null): Promise<void> {
  await updateMeta(id, (m) => ({ ...m, thumb }))
}

export async function renameProject(id: string, name: string): Promise<void> {
  await updateMeta(id, (m) => ({ ...m, name: name.trim() || m.name, updatedAt: Date.now() }))
}

export async function setProjectStatus(id: string, status: ProjectStatus): Promise<void> {
  await updateMeta(id, (m) => ({ ...m, status, updatedAt: Date.now() }))
}

/**
 * 保存显示/拼豆参数。排除颜色会改变豆子总数，所以要允许调用方传入重算后的 total。
 */
export async function saveProjectSettings(
  id: string,
  settings: ProjectSettings,
  total?: number,
): Promise<void> {
  await updateMeta(id, (m) => {
    const nextTotal = typeof total === 'number' ? total : m.total
    const nextDone = Math.min(m.doneCount, nextTotal)
    return {
      ...m,
      settings,
      total: nextTotal,
      doneCount: nextDone,
      status:
        m.status === 'failed' ? 'failed' : nextTotal > 0 && nextDone >= nextTotal ? 'done' : 'active',
      updatedAt: Date.now(),
    }
  })
}

/**
 * 保存进度。done 变化非常频繁（每点一格），所以只写 progress + 更新 meta 里的计数，
 * 不碰 patterns / images。
 */
export async function saveProjectProgress(
  id: string,
  done: Uint8Array,
  cells: Int16Array,
  blank: Uint8Array,
  excluded: Iterable<number>,
  total: number,
): Promise<{ status: ProjectStatus; doneCount: number }> {
  const doneCount = doneTotal(done, cells, blank, excluded)
  let status: ProjectStatus = 'active'
  await tx([S_META, S_PROGRESS], 'readwrite', async (t) => {
    t.objectStore(S_PROGRESS).put({ id, done })
    const metaStore = t.objectStore(S_META)
    const m = await reqOf(metaStore.get(id) as IDBRequest<ProjectMeta | undefined>)
    if (!m) return
    status =
      total > 0 && doneCount >= total
        ? 'done'
        : m.status === 'failed'
          ? 'failed'
          : 'active'
    metaStore.put({ ...m, doneCount, total, status, updatedAt: Date.now() })
  })
  return { status, doneCount }
}

export async function deleteProject(id: string): Promise<void> {
  await tx([S_META, S_PATTERN, S_PROGRESS, S_IMAGES], 'readwrite', (t) => {
    t.objectStore(S_META).delete(id)
    t.objectStore(S_PATTERN).delete(id)
    t.objectStore(S_PROGRESS).delete(id)
    t.objectStore(S_IMAGES).delete(id)
  })
}

export async function deleteProjects(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await tx([S_META, S_PATTERN, S_PROGRESS, S_IMAGES], 'readwrite', (t) => {
    for (const id of ids) {
      t.objectStore(S_META).delete(id)
      t.objectStore(S_PATTERN).delete(id)
      t.objectStore(S_PROGRESS).delete(id)
      t.objectStore(S_IMAGES).delete(id)
    }
  })
}

/** 生成「项目N」形式的默认名字：取现有项目里最大的编号 + 1 */
export function nextProjectName(existing: { name: string }[]): string {
  let max = 0
  for (const p of existing) {
    const m = /^项目\s*(\d+)$/.exec(p.name.trim())
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return `项目${max + 1}`
}

/* ----------------------------- 旧数据迁移 ----------------------------- */

const MIGRATED_KEY = 'perler-assistant/projects/migrated'

export function isLegacyMigrated(): boolean {
  try {
    return localStorage.getItem(MIGRATED_KEY) === '1'
  } catch {
    return true
  }
}

export function markLegacyMigrated(): void {
  try {
    localStorage.setItem(MIGRATED_KEY, '1')
  } catch {
    /* ignore */
  }
}
