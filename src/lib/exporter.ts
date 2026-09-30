import { EMPTY, type Brand, type GridSpec, type Plan } from '../types'
import { PALETTE, codeOf, readableTextColor } from './color'

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function safeName(name: string): string {
  return (name || 'pattern').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
}

/** 采购清单 CSV（带 BOM，Excel/WPS 直接打开不乱码） */
export function exportShoppingCsv(
  plan: Plan,
  brand: Brand,
  name: string,
  doneCounts: Map<number, number>,
) {
  const rows: string[][] = [['色号(' + brand + ')', 'HEX', '需要数量', '已拼', '剩余']]
  let total = 0
  for (const idx of plan.colors) {
    const need = plan.counts.get(idx) ?? 0
    const done = doneCounts.get(idx) ?? 0
    total += need
    rows.push([codeOf(idx, brand), PALETTE[idx].hex, String(need), String(done), String(need - done)])
  }
  rows.push(['合计', '', String(total), '', ''])
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n')
  triggerDownload(
    new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }),
    `${safeName(name)}-采购清单.csv`,
  )
}

/** 采购清单图片：色块 + 色号 + 数量 */
export function exportShoppingPng(
  plan: Plan,
  brand: Brand,
  name: string,
  doneCounts: Map<number, number>,
) {
  const rowH = 44
  const width = 460
  const headerH = 70
  const legendH = 46
  const rows = plan.colors.length
  const height = headerH + rows * rowH + legendH

  const cv = document.createElement('canvas')
  cv.width = width
  cv.height = height
  const ctx = cv.getContext('2d')
  if (!ctx) return

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = '#111827'
  ctx.font = '700 22px ui-sans-serif, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText(`${safeName(name)} 采购清单`, 20, 30)
  ctx.font = '400 13px ui-sans-serif, system-ui, sans-serif'
  ctx.fillStyle = '#6b7280'
  ctx.fillText(`色号体系：${brand} · 共 ${plan.colors.length} 色 · 合计 ${plan.total} 粒`, 20, 52)

  let y = headerH
  for (const idx of plan.colors) {
    const entry = PALETTE[idx]
    const need = plan.counts.get(idx) ?? 0
    const done = doneCounts.get(idx) ?? 0
    ctx.fillStyle = '#f9fafb'
    ctx.fillRect(12, y + 2, width - 24, rowH - 6)
    ctx.fillStyle = entry.hex
    ctx.fillRect(20, y + 8, 30, 30)
    ctx.strokeStyle = '#d1d5db'
    ctx.lineWidth = 1
    ctx.strokeRect(20.5, y + 8.5, 29, 29)
    ctx.fillStyle = '#111827'
    ctx.font = '700 17px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText(codeOf(idx, brand), 62, y + rowH / 2)
    ctx.font = '400 12px ui-sans-serif, system-ui, sans-serif'
    ctx.fillStyle = '#9ca3af'
    ctx.fillText(entry.hex, 140, y + rowH / 2)
    ctx.fillStyle = '#111827'
    ctx.font = '700 18px ui-sans-serif, system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(`${need} 粒`, width - 28, y + rowH / 2)
    if (done > 0) {
      ctx.fillStyle = done >= need ? '#059669' : '#6b7280'
      ctx.font = '400 12px ui-sans-serif, system-ui, sans-serif'
      ctx.fillText(done >= need ? '已拼完' : `已拼 ${done}`, width - 110, y + rowH / 2)
    }
    ctx.textAlign = 'left'
    y += rowH
  }

  cv.toBlob((blob) => {
    if (blob) triggerDownload(blob, `${safeName(name)}-采购清单.png`)
  }, 'image/png')
}

/** 把识别结果导出成一张带色号的图纸，用来核对识别是否正确 */
export function exportRecognizedPattern(
  cells: Int16Array,
  grid: GridSpec,
  brand: Brand,
  name: string,
  selected: number | null,
) {
  const { cols, rows } = grid
  const cell = Math.max(8, Math.min(30, Math.round(2200 / Math.max(cols, rows))))
  const pad = 24
  const fontPx = Math.max(7, Math.round(cell * 0.42))
  const showCodes = cell >= 12

  const width = pad * 2 + cols * cell
  const height = pad * 2 + rows * cell

  const cv = document.createElement('canvas')
  cv.width = width
  cv.height = height
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = cells[r * cols + c]
      const x = pad + c * cell
      const y = pad + r * cell
      if (v === EMPTY || v < 0) {
        ctx.fillStyle = '#f3f4f6'
      } else {
        ctx.fillStyle = PALETTE[v].hex
      }
      ctx.fillRect(x, y, cell, cell)
    }
  }

  // 网格线
  ctx.strokeStyle = 'rgba(0,0,0,0.18)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let c = 0; c <= cols; c++) {
    const x = pad + c * cell + 0.5
    ctx.moveTo(x, pad)
    ctx.lineTo(x, pad + rows * cell)
  }
  for (let r = 0; r <= rows; r++) {
    const y = pad + r * cell + 0.5
    ctx.moveTo(pad, y)
    ctx.lineTo(pad + cols * cell, y)
  }
  ctx.stroke()

  // 每 10 格加粗
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let c = 0; c <= cols; c += 10) {
    const x = pad + c * cell + 0.5
    ctx.moveTo(x, pad)
    ctx.lineTo(x, pad + rows * cell)
  }
  for (let r = 0; r <= rows; r += 10) {
    const y = pad + r * cell + 0.5
    ctx.moveTo(pad, y)
    ctx.lineTo(pad + cols * cell, y)
  }
  ctx.stroke()

  if (showCodes) {
    ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = cells[r * cols + c]
        if (v === EMPTY || v < 0) continue
        if (selected !== null && v !== selected) continue
        ctx.fillStyle = readableTextColor(PALETTE[v].rgb)
        ctx.fillText(codeOf(v, brand), pad + (c + 0.5) * cell, pad + (r + 0.5) * cell)
      }
    }
  }

  ctx.strokeStyle = '#111827'
  ctx.lineWidth = 2
  ctx.strokeRect(pad - 1, pad - 1, cols * cell + 2, rows * cell + 2)

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#9ca3af'
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
  ctx.fillText(`${safeName(name)} · 识别结果 · ${cols}×${rows} · ${brand}`, pad, 16)

  cv.toBlob((blob) => {
    if (blob) triggerDownload(blob, `${safeName(name)}-识别结果.png`)
  }, 'image/png')
}

export function downloadText(text: string, filename: string) {
  triggerDownload(new Blob([text], { type: 'application/json;charset=utf-8' }), filename)
}
