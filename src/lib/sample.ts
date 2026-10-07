import type { GridSpec } from '../types'

export interface SampleResult {
  /** 长度 rows*cols*3，每格的主导色 RGB */
  rgb: Uint8ClampedArray
  /** 长度 rows*cols，主导色在采样区域中的占比 0..1 */
  purity: Float32Array
}

const BUCKETS = 32768 // 5 bit / 通道
const Q = 3 // >> 3

/**
 * 逐格提取「主导色」。
 *
 * 两个关键点：
 *
 * 1) 取局部众数（主导色）而不是整格均值。JPEG 会把同一种填色分散到相邻
 *    的量化桶；合计相邻桶的支持数，再只在这一小簇内平均，避免量化边界
 *    把主色拆开。文字、格线和水印的远色不参与这个平均。
 *
 * 2) 采「边框」而不是「中心」。拼豆图纸的色号文字是**居中**印的，
 *    所以格子中心恰恰是最脏的地方；而贴着格线内侧的一圈是纯净填充色。
 *    实测某实拍图纸格距只有 13.85px、格内几乎印满色号，采中心会把
 *    38 种颜色打成 115 种；改采边框后颜色数才回到真实值附近。
 *    边框宽度太窄（格子太小）时回退到中心区块，保证仍有足够像素可统计。
 */
export function sampleCells(img: ImageData, grid: GridSpec): SampleResult {
  const { width: W, height: H, data } = img
  const n = Math.max(0, grid.cols) * Math.max(0, grid.rows)
  const rgb = new Uint8ClampedArray(n * 3)
  const purity = new Float32Array(n)

  const count = new Int32Array(BUCKETS)
  const sumR = new Float64Array(BUCKETS)
  const sumG = new Float64Array(BUCKETS)
  const sumB = new Float64Array(BUCKETS)
  const touched: number[] = []

  const minSide = Math.max(1, Math.min(grid.cellW, grid.cellH))
  const inset = Math.max(1, Math.round(minSide * 0.12))
  const band = Math.max(1, Math.round(minSide * 0.2))

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const idx = r * grid.cols + c

      const rawX0 = grid.offsetX + c * grid.cellW
      const rawY0 = grid.offsetY + r * grid.cellH
      const xa = Math.round(rawX0)
      const ya = Math.round(rawY0)
      const xb = Math.round(rawX0 + grid.cellW)
      const yb = Math.round(rawY0 + grid.cellH)
      if (xb <= xa || yb <= ya) {
        purity[idx] = 0
        continue
      }

      // 边框各条带（避开格线与抗锯齿，同时避开居中的文字块）
      const leftLo = xa + inset
      const leftHi = Math.min(leftLo + band, xb)
      const rightHi = xb - inset
      const rightLo = Math.max(rightHi - band, xa)
      const topLo = ya + inset
      const topHi = Math.min(topLo + band, yb)
      const bottomHi = yb - inset
      const bottomLo = Math.max(bottomHi - band, ya)

      for (const k of touched) {
        count[k] = 0
        sumR[k] = 0
        sumG[k] = 0
        sumB[k] = 0
      }
      touched.length = 0

      let total = 0
      let bestKey = -1
      let bestCount = 0

      const feed = (x0: number, y0: number, x1: number, y1: number) => {
        const ax = Math.max(0, x0)
        const ay = Math.max(0, y0)
        const bx = Math.min(W, x1)
        const by = Math.min(H, y1)
        for (let y = ay; y < by; y++) {
          let p = (y * W + ax) * 4
          for (let x = ax; x < bx; x++, p += 4) {
            if (data[p + 3] < 128) continue
            const cr = data[p]
            const cg = data[p + 1]
            const cb = data[p + 2]
            const key = ((cr >> Q) << 10) | ((cg >> Q) << 5) | (cb >> Q)
            if (count[key] === 0) touched.push(key)
            count[key]++
            sumR[key] += cr
            sumG[key] += cg
            sumB[key] += cb
            total++
          }
        }
      }

      const midTop = Math.max(topHi, topLo)
      const midBottom = Math.max(bottomLo, midTop)
      // 上下两条（横跨中间区域） + 左右两条（只取上下带之间的部分），不重复计数
      feed(leftLo, topLo, rightHi, topHi)
      feed(leftLo, bottomLo, rightHi, bottomHi)
      feed(leftLo, midTop, leftHi, midBottom)
      feed(rightLo, midTop, rightHi, midBottom)

      if (total < 6) {
        // 边框太窄（格子很小）：回退到中心区块
        for (const k of touched) {
          count[k] = 0
          sumR[k] = 0
          sumG[k] = 0
          sumB[k] = 0
        }
        touched.length = 0
        total = 0
        feed(xa + inset, ya + inset, xb - inset, yb - inset)
      }

      if (total === 0) {
        purity[idx] = 0
        continue
      }

      let bestR = 0
      let bestG = 0
      let bestB = 0
      for (const k of touched) {
        const kr = k >> 10
        const kg = (k >> 5) & 31
        const kb = k & 31
        let support = 0
        let sr = 0
        let sg = 0
        let sb = 0
        // 有界邻域不做传递合并：JPEG同一填色可能横跨多个8级量化桶。
        for (let r1 = Math.max(0, kr - 1); r1 <= Math.min(31, kr + 1); r1++) {
          for (let g1 = Math.max(0, kg - 1); g1 <= Math.min(31, kg + 1); g1++) {
            for (let b1 = Math.max(0, kb - 1); b1 <= Math.min(31, kb + 1); b1++) {
              const key = (r1 << 10) | (g1 << 5) | b1
              support += count[key]
              sr += sumR[key]
              sg += sumG[key]
              sb += sumB[key]
            }
          }
        }
        // 邻域支持相同时选自身像素更多的桶，保持可复现性。
        if (support > bestCount || (support === bestCount && count[k] > count[bestKey])) {
          bestCount = support
          bestKey = k
          bestR = sr
          bestG = sg
          bestB = sb
        }
      }
      if (bestKey < 0) {
        purity[idx] = 0
        continue
      }

      rgb[idx * 3] = Math.round(bestR / bestCount)
      rgb[idx * 3 + 1] = Math.round(bestG / bestCount)
      rgb[idx * 3 + 2] = Math.round(bestB / bestCount)
      purity[idx] = bestCount / total
    }
  }

  return { rgb, purity }
}
