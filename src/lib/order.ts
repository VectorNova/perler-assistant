import {
  EMPTY,
  type Brand,
  type CellOrderMode,
  type ColorOrderMode,
  type ColorStep,
  type GridSpec,
  type OrderOptions,
  type Plan,
  type Region,
  type RegionOrderMode,
} from '../types'
import { PALETTE, codeOf } from './color'

/** 最近邻路径超过这个规模就退化为蛇形扫描（避免 O(n²)） */
const NN_LIMIT = 2500

function rowOf(i: number, cols: number): number {
  return Math.floor(i / cols)
}

function colOf(i: number, cols: number): number {
  return i - Math.floor(i / cols) * cols
}

/** 逐行（索引升序即逐行从左到右） */
function orderRow(indices: number[]): number[] {
  return indices.slice().sort((a, b) => a - b)
}

/** 蛇形：隔行反向，减少来回移动 */
function orderSnake(indices: number[], cols: number): number[] {
  const byRow = new Map<number, number[]>()
  for (const i of indices) {
    const r = rowOf(i, cols)
    const arr = byRow.get(r)
    if (arr) arr.push(i)
    else byRow.set(r, [i])
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b)
  const out: number[] = []
  rows.forEach((r, k) => {
    const arr = (byRow.get(r) as number[]).sort((a, b) => a - b)
    if (k % 2 === 1) arr.reverse()
    out.push(...arr)
  })
  return out
}

/** 贪心最近邻路径：从最左上的一格出发，每次走最近的未拼格 */
function orderNearest(indices: number[], cols: number): number[] {
  if (indices.length > NN_LIMIT) return orderSnake(indices, cols)
  const rs = new Int32Array(indices.length)
  const cs = new Int32Array(indices.length)
  let start = 0
  for (let k = 0; k < indices.length; k++) {
    rs[k] = rowOf(indices[k], cols)
    cs[k] = colOf(indices[k], cols)
    if (rs[k] < rs[start] || (rs[k] === rs[start] && cs[k] < cs[start])) start = k
  }
  const used = new Uint8Array(indices.length)
  const out: number[] = []
  let cur = start
  used[cur] = 1
  out.push(indices[cur])
  for (let step = 1; step < indices.length; step++) {
    let best = -1
    let bestD = Infinity
    const cr = rs[cur]
    const cc = cs[cur]
    for (let k = 0; k < indices.length; k++) {
      if (used[k]) continue
      const dr = rs[k] - cr
      const dc = cs[k] - cc
      const d = dr * dr + dc * dc
      if (d < bestD) {
        bestD = d
        best = k
        if (d === 1) break
      }
    }
    if (best < 0) break
    used[best] = 1
    out.push(indices[best])
    cur = best
  }
  return out
}

export function orderCells(
  indices: number[],
  cols: number,
  mode: CellOrderMode,
): number[] {
  switch (mode) {
    case 'row':
      return orderRow(indices)
    case 'nearest':
      return orderNearest(indices, cols)
    case 'snake':
    default:
      return orderSnake(indices, cols)
  }
}

/** 把一组格子按 4 连通拆成色块（返回的是格子下标的数组） */
export function splitBlobs(indices: number[], cols: number, rows: number): number[][] {
  const set = new Set(indices)
  const seen = new Set<number>()
  const blobs: number[][] = []
  const sorted = indices.slice().sort((a, b) => a - b)
  for (const startIdx of sorted) {
    if (seen.has(startIdx)) continue
    const stack = [startIdx]
    seen.add(startIdx)
    const comp: number[] = []
    while (stack.length > 0) {
      const cur = stack.pop() as number
      comp.push(cur)
      const r = rowOf(cur, cols)
      const c = colOf(cur, cols)
      const tryPush = (x: number) => {
        if (x < 0 || x >= cols * rows || seen.has(x)) return
        if (!set.has(x)) return
        seen.add(x)
        stack.push(x)
      }
      if (r > 0) tryPush(cur - cols)
      if (r < rows - 1) tryPush(cur + cols)
      if (c > 0) tryPush(cur - 1)
      if (c < cols - 1) tryPush(cur + 1)
    }
    blobs.push(comp)
  }
  blobs.sort((a, b) => b.length - a.length)
  return blobs
}

/** 由格子集合算出色块的包围盒、中心、是否贴边，并排好内部路径 */
function makeRegion(raw: number[], cols: number, rows: number, cellMode: CellOrderMode): Region {
  let minR = Infinity
  let maxR = -1
  let minC = Infinity
  let maxC = -1
  let sumR = 0
  let sumC = 0
  for (const i of raw) {
    const r = rowOf(i, cols)
    const c = colOf(i, cols)
    if (r < minR) minR = r
    if (r > maxR) maxR = r
    if (c < minC) minC = c
    if (c > maxC) maxC = c
    sumR += r
    sumC += c
  }
  const cells = orderCells(raw, cols, cellMode)
  return {
    cells,
    size: cells.length,
    minR,
    maxR,
    minC,
    maxC,
    centerR: Math.round(sumR / raw.length),
    centerC: Math.round(sumC / raw.length),
    touchesEdge: minR === 0 || minC === 0 || maxR === rows - 1 || maxC === cols - 1,
  }
}

/** 两个色块之间的「空隙」：包围盒之间隔了几格；贴着的两块为 0 */
function regionGap(a: Region, b: Region): number {
  const dR = Math.max(0, Math.max(a.minR - b.maxR, b.minR - a.maxR))
  const dC = Math.max(0, Math.max(a.minC - b.maxC, b.minC - a.maxC))
  return dR + dC
}

/**
 * 2-opt 清理：把链上「交叉」的两条相邻边拆开重连（即反转中间一段），
 * 只要总移动距离变短就保留。
 *
 * 纯贪心最近邻有个经典毛病：走到后面会剩下几个孤立块，被迫来一次长距离跳跃
 * （实测 83 块里有一次性跳 74 格）。2-opt 能把这根长边消掉，
 * 而且因为只反转内部区段，起点（最左上那块）保持不动。
 */
function twoOptImprove(order: Region[], maxPasses = 4, limit = 600): Region[] {
  const n = order.length
  if (n < 4 || n > limit) return order
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false
    for (let i = 0; i < n - 2; i++) {
      for (let j = i + 2; j < n; j++) {
        const a = order[i]
        const b = order[i + 1]
        const c = order[j]
        const d = j + 1 < n ? order[j + 1] : null
        const before = regionGap(a, b) + (d ? regionGap(c, d) : 0)
        const after = regionGap(a, c) + (d ? regionGap(b, d) : 0)
        if (after < before) {
          let lo = i + 1
          let hi = j
          while (lo < hi) {
            const tmp = order[lo]
            order[lo] = order[hi]
            order[hi] = tmp
            lo++
            hi--
          }
          improved = true
        }
      }
    }
    if (!improved) break
  }
  return order
}

/**
 * 「就近连续」顺序：从最靠左上的一块开始，每一步都走向离当前块最近的下一块，
 * 最后用 2-opt 消掉贪婪留下的长跳跃。
 *
 * 为什么不用「大块优先」：它按面积排，和位置完全无关，拼完一块下一块可能
 * 跳到图纸另一头 —— 拼豆时手要来回跑，体验很差（实测总移动距离是就近连续的 4 倍）。
 *
 * 为什么用「包围盒空隙」而不是中心距离：贴在一起的两块空隙是 0，
 * 中心距离却会因为有大小差异而虚高；按空隙走才是真正「挨着拼」。
 *
 * 阅读方向偏置：只在空隙相同（都贴着）时起作用，优先往右、往下，
 * 避免在同一片区域里来回折返。
 */
function orderRegionsFlow(input: Region[]): Region[] {
  const n = input.length
  if (n <= 2) return input
  // 块数太多时退化成逐行扫描，避免 O(n²)
  if (n > 1200) {
    return input.slice().sort((a, b) => a.minR - b.minR || a.minC - b.minC)
  }

  let start = 0
  for (let k = 1; k < n; k++) {
    const a = input[k]
    const b = input[start]
    if (a.minR < b.minR || (a.minR === b.minR && a.minC < b.minC)) start = k
  }

  const used = new Uint8Array(n)
  const out: Region[] = []
  let cur = start
  used[cur] = 1
  out.push(input[cur])

  for (let step = 1; step < n; step++) {
    const c = input[cur]
    let best = -1
    let bestCost = Infinity
    for (let k = 0; k < n; k++) {
      if (used[k]) continue
      const r = input[k]
      const gap = regionGap(c, r)
      // 往回（上方/左侧）走的轻微惩罚，只在空隙相同时影响选择
      const back = (r.minR < c.minR - 1 ? 2 : 0) + (r.minC < c.minC - 1 ? 1 : 0)
      const cost = gap * 6 + back
      if (cost < bestCost) {
        bestCost = cost
        best = k
      }
    }
    if (best < 0) break
    used[best] = 1
    out.push(input[best])
    cur = best
  }
  return twoOptImprove(out)
}

/** 一种颜色的全部色块，按 regionOrder 排好优先级 */
export function buildRegions(
  indices: number[],
  cols: number,
  rows: number,
  cellMode: CellOrderMode,
  regionOrder: RegionOrderMode,
): Region[] {
  const blobs = splitBlobs(indices, cols, rows) // 已按面积降序
  let regions = blobs.map((b) => makeRegion(b, cols, rows, cellMode))
  switch (regionOrder) {
    case 'edgeFirst':
      regions.sort((a, b) => Number(b.touchesEdge) - Number(a.touchesEdge) || b.size - a.size)
      break
    case 'rowMajor':
      regions.sort((a, b) => a.minR - b.minR || a.minC - b.minC)
      break
    case 'flow':
      regions = orderRegionsFlow(regions)
      break
    case 'nearest':
    case 'largest':
    default:
      // 保持 splitBlobs 的面积降序
      break
  }
  return regions
}

/** 色块优先级选项（指南面板和设置面板共用一份，避免两边不一致） */
export const REGION_ORDER_OPTIONS: { mode: RegionOrderMode; label: string; hint: string }[] = [
  { mode: 'flow', label: '就近连续（推荐）', hint: '从左上开始，每步走最近的一块，不会大跳' },
  { mode: 'rowMajor', label: '逐行扫描', hint: '从上到下、从左到右，一行一行来' },
  { mode: 'nearest', label: '离上一块最近', hint: '动态跟随你上次拼的位置' },
  { mode: 'largest', label: '大块优先', hint: '按面积从大到小，效率高但会跳' },
  { mode: 'edgeFirst', label: '边缘优先', hint: '贴着外沿的块先拼' },
]

/** 一块之内的下笔顺序选项（桌面右栏和移动端抽屉共用） */
export const CELL_ORDER_OPTIONS: { mode: CellOrderMode; label: string }[] = [
  { mode: 'snake', label: '蛇形（隔行反向，推荐）' },
  { mode: 'row', label: '逐行，从左到右' },
  { mode: 'nearest', label: '最近邻路径（少走动）' },
]

export function indicesOfColor(cells: Int16Array, paletteIndex: number): number[] {
  const out: number[] = []
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === paletteIndex) out.push(i)
  }
  return out
}

function orderColorIndices(
  plan: Plan,
  cells: Int16Array,
  mode: ColorOrderMode,
  brand: Brand,
): number[] {
  const colors = plan.colors.slice()
  switch (mode) {
    case 'countAsc':
      return colors.reverse()
    case 'firstSeen': {
      const first = new Map<number, number>()
      for (let i = 0; i < cells.length; i++) {
        const v = cells[i]
        if (v === EMPTY || first.has(v)) continue
        first.set(v, i)
      }
      return colors.sort((a, b) => (first.get(a) ?? 0) - (first.get(b) ?? 0))
    }
    case 'code':
      return colors.sort((a, b) =>
        codeOf(a, brand).localeCompare(codeOf(b, brand), 'en', { numeric: true }),
      )
    case 'countDesc':
    default:
      return colors
  }
}

/** 生成完整的拼装指引：颜色顺序 + 每个颜色内部的色块顺序 */
export function buildSteps(
  plan: Plan,
  grid: GridSpec,
  opts: OrderOptions,
  brand: Brand,
): ColorStep[] {
  const { cols, rows } = grid
  const ordered = orderColorIndices(plan, plan.cells, opts.colorOrder, brand)
  return ordered.map((paletteIndex) => {
    const indices = indicesOfColor(plan.cells, paletteIndex)
    const regions = buildRegions(indices, cols, rows, opts.cellOrder, opts.regionOrder)
    const cells: number[] = []
    for (const r of regions) cells.push(...r.cells)
    return {
      paletteIndex,
      key: codeOf(paletteIndex, brand),
      hex: PALETTE[paletteIndex].hex,
      count: cells.length,
      cells,
      regions,
    }
  })
}

export function isRegionDone(region: Region, done: ReadonlySet<number>): boolean {
  for (const i of region.cells) if (!done.has(i)) return false
  return true
}

export function regionPendingCells(region: Region, done: ReadonlySet<number>): number[] {
  return region.cells.filter((i) => !done.has(i))
}

/** 每个色块是否已完成 */
export function regionDoneFlags(regions: Region[], done: ReadonlySet<number>): boolean[] {
  return regions.map((r) => isRegionDone(r, done))
}

/**
 * 选出「现在该拼哪一块」。
 * largest / edgeFirst 在 buildRegions 里已经排好，取第一个没拼完的即可；
 * nearest 依赖上一次落点，所以放在渲染时算，避免每次标记都重建 steps。
 */
export function pickRegionIndex(
  regions: Region[],
  done: ReadonlySet<number>,
  mode: RegionOrderMode,
  refCell: number | null,
  cols: number,
): number {
  if (mode !== 'nearest' || refCell === null || cols <= 0) {
    for (let k = 0; k < regions.length; k++) {
      if (!isRegionDone(regions[k], done)) return k
    }
    return -1
  }
  const rr = Math.floor(refCell / cols)
  const rc = refCell % cols
  let best = -1
  let bestD = Infinity
  for (let k = 0; k < regions.length; k++) {
    const reg = regions[k]
    if (isRegionDone(reg, done)) continue
    const d = Math.abs(reg.centerR - rr) + Math.abs(reg.centerC - rc)
    if (d < bestD) {
      bestD = d
      best = k
    }
  }
  return best
}

/** 取包含 index 的同色连通块（用于点画布直接标记一整块） */
export function blobAt(cells: Int16Array, cols: number, rows: number, index: number): number[] {
  const target = cells[index]
  if (target === EMPTY) return []
  const seen = new Set<number>([index])
  const stack = [index]
  const out: number[] = []
  while (stack.length > 0) {
    const cur = stack.pop() as number
    out.push(cur)
    const r = rowOf(cur, cols)
    const c = colOf(cur, cols)
    const tryPush = (x: number) => {
      if (x < 0 || x >= cells.length || seen.has(x)) return
      if (cells[x] !== target) return
      seen.add(x)
      stack.push(x)
    }
    if (r > 0) tryPush(cur - cols)
    if (r < rows - 1) tryPush(cur + cols)
    if (c > 0) tryPush(cur - 1)
    if (c < cols - 1) tryPush(cur + 1)
  }
  return out
}
