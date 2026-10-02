import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, Maximize2, Minimize2, Scan, Undo2, X } from 'lucide-react'
import ProjectHome from './components/ProjectHome'
import Logo from './components/Logo'
import CalibrateView from './components/CalibrateView'
import PatternCanvas, { type DimMode } from './components/PatternCanvas'
import ColorList from './components/ColorList'
import GuidePanel from './components/GuidePanel'
import DisplaySettings from './components/DisplaySettings'
import PatternInfo from './components/PatternInfo'
import MobileDrawer, { type MobileSheet } from './components/MobileDrawer'
import { useIsMobile } from './lib/useIsMobile'
import {
  BRANDS,
  EMPTY,
  type Brand,
  type ChartRecognition,
  type GridSpec,
  type OrderOptions,
  type Pattern,
} from './types'
import { blankCount, buildPattern, derivePlan, hashImage, rawCounts } from './lib/pattern'
import {
  CELL_BACKGROUND,
  CELL_CLOSE_COLORS,
  CELL_LOW_PURITY,
  CELL_TEXT_UNCERTAIN,
  CELL_TEXT_CONFLICT,
  lowConfidenceCells,
} from './lib/pattern'
import {
  blobAt,
  buildSteps,
  pickRegionIndex,
  regionDoneFlags,
  regionPendingCells,
} from './lib/order'
import { clampGrid, detectGrid, gridFromCellCount } from './lib/gridDetect'
import { recognizeChart } from './lib/chartOcr'
import { assetUrl } from './lib/assets'
import { PALETTE, PALETTE_SYSTEMS, codeOf, indicesInSystem, intersectWithSystem, resolveColorCodes } from './lib/color'
import type { PaletteSystemId } from './lib/color'
import {
  clearSession,
  decodeBitset,
  encodeBitset,
  exportProgressText,
  i16ToBase64,
  loadSession,
} from './lib/storage'
import {
  createProject,
  deleteProject,
  deleteProjects,
  getProjectImage,
  getProjectMeta,
  getProjectPattern,
  getProjectProgress,
  isLegacyMigrated,
  listProjects,
  markLegacyMigrated,
  newId,
  nextProjectName,
  patternThumbDataUrl,
  renameProject as renameProjectStore,
  replaceProjectPattern,
  saveProjectImage,
  saveProjectProgress,
  saveProjectSettings,
  setProjectStatus,
  updateProjectThumb,
  type ProjectPattern,
  type ProjectSettings,
  type ProjectStatus,
  type ProjectSummary,
} from './lib/projects'
import {
  downloadText,
  exportRecognizedPattern,
  exportShoppingCsv,
  exportShoppingPng,
} from './lib/exporter'

type Stage = 'upload' | 'calibrate' | 'work'
type Mode = 'browse' | 'guide'
type HistoryEntry = { op: 'add' | 'remove'; cells: number[] }

const MAX_IMAGE_PIXELS = 64_000_000

const EMPTY_GRID: GridSpec = { offsetX: 0, offsetY: 0, cellW: 20, cellH: 20, cols: 32, rows: 32 }

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败，换个格式试试'))
    img.src = src
  })
}

function formatElapsed(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function App() {
  const [stage, setStage] = useState<Stage>('upload')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const imgCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgDataRef = useRef<ImageData | null>(null)
  const recognitionCacheRef = useRef<{ image: ImageData; key: string; value: ChartRecognition } | null>(null)
  const [imageToken, setImageToken] = useState(0)
  const [fileName, setFileName] = useState('')
  const [imageHash, setImageHash] = useState('')
  const [grid, setGrid] = useState<GridSpec>(EMPTY_GRID)
  const [detectHint, setDetectHint] = useState<string | null>(null)
  const [detectDebug, setDetectDebug] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ colors: number; beads: number; blank: number } | null>(null)

  const [pattern, setPattern] = useState<Pattern | null>(null)
  const [treatBlankAsEmpty, setTreatBlankAsEmpty] = useState(true)

  const [brand, setBrand] = useState<Brand>('MARD')
  const [excluded, setExcluded] = useState<Set<number>>(() => new Set())
  const [done, setDone] = useState<Set<number>>(() => new Set())
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [orderOpts, setOrderOpts] = useState<OrderOptions>({
    colorOrder: 'countDesc',
    cellOrder: 'snake',
    // 默认「就近连续」：从左上开始一块块挨着拼。
    // 之前默认「大块优先」是按面积排的，和位置无关，拼完一块下一块会跳到图纸另一头。
    regionOrder: 'flow',
  })

  const [selected, setSelected] = useState<number | null>(null)
  const [mode, setMode] = useState<Mode>('browse')
  const [stepIndex, setStepIndex] = useState(0)
  const [autoAdvance, setAutoAdvance] = useState(true)
  /** 指引的工作单元：按色块（默认，像参考项目）还是按单粒 */
  const [guideUnit, setGuideUnit] = useState<'region' | 'cell'>('region')
  /** 手动选中的色块下标；null = 自动挑 */
  const [regionPick, setRegionPick] = useState<number | null>(null)
  /** 最近一次落点，供「离上一块最近优先」用 */
  const [refCell, setRefCell] = useState<number | null>(null)
  const [rightTab, setRightTab] = useState<'guide' | 'display' | 'info'>('guide')

  const [dimMode, setDimMode] = useState<DimMode>('dim')
  const [showGrid, setShowGrid] = useState(true)
  const [showCodes, setShowCodes] = useState(true)
  const [showSectionLines, setShowSectionLines] = useState(true)
  const [sectionInterval, setSectionInterval] = useState(10)
  const [showExcluded, setShowExcluded] = useState(true)
  const [showLowConf, setShowLowConf] = useState(true)
  const [lowCursor, setLowCursor] = useState(0)
  /** 图纸图例里的色号（用来把色板收窄到这张图纸真正用到的颜色） */
  const [codeText, setCodeText] = useState('')
  const [allowedIndices, setAllowedIndices] = useState<number[] | null>(null)
  /**
   * 色号体系。默认 MARD 221（国内零售最常见），
   * 这样识别结果**不可能**落到 P/Q/R/T/Y/ZG 这 70 个 221 体系里不存在的色号上。
   * 用户报的「识别出原图没有的 P1、R8」就是没区分 221/291 造成的。
   */
  const [paletteSystem, setPaletteSystem] = useState<PaletteSystemId>('MARD221')
  /**
   * 是否允许出现图例之外的颜色。默认关。
   * 打开后，与所有图例色号都差得较远的格子会回退到全色板 ——
   * 代价是**可能凭空造出图纸上没有的色号**（用户反馈的 P1/R8 就是这么来的），
   * 所以只在确认图例抄漏了色号时才该开。
   */
  const [allowForeignColors, setAllowForeignColors] = useState(false)
  const [codeNote, setCodeNote] = useState<string | null>(null)
  const [focusOnColor, setFocusOnColor] = useState(false)

  /* ------------------------- 手机端外壳 ------------------------- */
  const isMobile = useIsMobile()
  const [sheet, setSheet] = useState<MobileSheet>('guide')
  const [sheetExpanded, setSheetExpanded] = useState(false)
  const [immersive, setImmersive] = useState(false)

  useEffect(() => {
    if (!isMobile || stage !== 'work') setImmersive(false)
  }, [isMobile, stage])

  useEffect(() => {
    if (!notice || !isMobile || stage !== 'work') return
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [notice, isMobile, stage])

  useEffect(() => {
    if (!immersive) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImmersive(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [immersive])

  /** 手机端切换抽屉标签时顺带切模式：颜色=看分布，指引=拼豆指引 */
  const pickSheet = useCallback((s: MobileSheet) => {
    setSheet(s)
    if (s === 'colors') setMode('browse')
    else if (s === 'guide') {
      setMode('guide')
      setRightTab('guide')
    } else {
      setRightTab(s === 'display' ? 'display' : 'info')
    }
  }, [])

  /* ------------------------- 项目管理 ------------------------- */
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  /** 当前正在拼的项目 id；null = 还没保存成项目的新图纸 */
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  /** 识别确认时记下的置信度，用于首页提示「可能是识别失败的那个」 */
  const [detectConfidence, setDetectConfidence] = useState(0)
  /** 项目名（默认「项目N」，确认前可改成图纸名） */
  const [projectName, setProjectName] = useState('项目1')
  /** 本次上传的图纸原图 + 缩略图，确认时一起落库 */
  const pendingImageRef = useRef<{ blob: Blob; name: string } | null>(null)
  const saveStateRef = useRef<{ saving: boolean; queued: boolean }>({ saving: false, queued: false })

  const [hover, setHover] = useState<number | null>(null)
  const [focusRequest, setFocusRequest] = useState<{
    index: number
    token: number
    bounds?: { minR: number; minC: number; maxR: number; maxC: number }
  } | null>(null)
  const [fitToken, setFitToken] = useState(0)
  const [elapsedSec, setElapsedSec] = useState(0)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const focusTokenRef = useRef(0)
  const warnedSaveRef = useRef(false)
  const autoConfirmRef = useRef(false)
  const [demoName, setDemoName] = useState<string | null>(null)

  const nextFocusToken = useCallback(() => {
    focusTokenRef.current += 1
    return focusTokenRef.current
  }, [])

  const refreshProjects = useCallback(async () => {
    try {
      const list = await listProjects()
      setProjects(list)
      return list
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return []
    } finally {
      setProjectsLoading(false)
    }
  }, [])

  /** 把当前所有界面参数打包成项目设置（保存项目 / 更新项目时用） */
  const settingsFromState = useCallback(
    (): ProjectSettings => ({
      brand,
      orderOpts: { ...orderOpts },
      excluded: [...excluded],
      codeText,
      allowedIndices,
      paletteSystem,
      treatBlankAsEmpty,
      dimMode,
      showGrid,
      showCodes,
      showSectionLines,
      sectionInterval,
      showExcluded,
      showLowConf,
    }),
    [
      brand,
      orderOpts,
      excluded,
      codeText,
      allowedIndices,
      paletteSystem,
      treatBlankAsEmpty,
      dimMode,
      showGrid,
      showCodes,
      showSectionLines,
      sectionInterval,
      showExcluded,
      showLowConf,
    ],
  )

  /**
   * 启动时加载项目列表。
   * 顺便把旧版单会话（localStorage）里的进度迁移成一个项目 ——
   * 老用户升级后不会丢掉正在拼的进度。
   */
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        if (!isLegacyMigrated()) {
          const s = loadSession()
          if (s) {
            const n = s.grid.cols * s.grid.rows
            const cells = new Int16Array(n)
            try {
              const bin = atob(s.cells)
              const bytes = new Uint8Array(bin.length)
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
              const src = new Int16Array(bytes.buffer, bytes.byteOffset, Math.min(n, bytes.byteLength >> 1))
              cells.set(src)
            } catch {
              /* 数据坏了就跳过 */
            }
            const blank = s.blank ? decodeBitset(s.blank, n) : new Uint8Array(n)
            const done = s.done ? decodeBitset(s.done, n) : new Uint8Array(n)
            const id = newId()
            await createProject({
              name: `${s.name || '旧进度'}（从旧版本导入）`,
              pattern: {
                id,
                imageHash: s.imageHash,
                imageName: s.name || '未知图纸',
                imageW: s.imageW,
                imageH: s.imageH,
                grid: s.grid,
                cells,
                blank,
                purity: new Float32Array(n).fill(1),
                pageBg: s.pageBg,
              },
              settings: {
                brand: s.brand,
                orderOpts: {
                  colorOrder: s.colorOrder,
                  cellOrder: s.cellOrder,
                  regionOrder: s.regionOrder ?? 'flow',
                },
                excluded: s.excluded,
                codeText: '',
                allowedIndices: null,
                treatBlankAsEmpty: true,
                dimMode: 'dim',
                showGrid: true,
                showCodes: true,
                showSectionLines: true,
                sectionInterval: 10,
                showExcluded: true,
                showLowConf: true,
              },
              done,
              image: null,
              thumb: null,
              confidence: 0,
            })
            markLegacyMigrated()
          } else {
            markLegacyMigrated()
          }
        }
      } catch {
        /* 迁移失败不影响使用 */
      }
      if (alive) await refreshProjects()
    })()
    return () => {
      alive = false
    }
  }, [refreshProjects])

  /* ------------------------- 计时 ------------------------- */

  useEffect(() => {
    if (stage !== 'work') return
    const t = setInterval(() => setElapsedSec((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [stage])

  /* ------------------------- 读取图纸 ------------------------- */

  /** 保留原生像素，避免先缩小再读字导致 6/8 等细节永久丢失。旧项目按原尺寸恢复。 */
  const prepareImageData = useCallback(
    async (blob: Blob, savedSize?: { width: number; height: number }): Promise<{ imgData: ImageData; canvas: HTMLCanvasElement } | null> => {
      const url = URL.createObjectURL(blob)
      try {
        const img = await loadImageElement(url)
        const nw = img.naturalWidth || img.width
        const nh = img.naturalHeight || img.height
        if (!nw || !nh) return null
        const w = savedSize?.width ?? nw
        const h = savedSize?.height ?? nh
        if (w * h > MAX_IMAGE_PIXELS) throw new Error('图片超过 6400 万像素，请裁掉图纸外的区域后导入，保留格内文字的原始清晰度。')
        // 分块读取原始像素，避免手机浏览器的单画布面积限制。
        const tile = document.createElement('canvas')
        const ctx = tile.getContext('2d', { willReadFrequently: true })
        if (!ctx) return null
        const imgData = new ImageData(w, h)
        for (let y = 0; y < h; y += 1024) {
          for (let x = 0; x < w; x += 2048) {
            const tw = Math.min(2048, w - x)
            const th = Math.min(1024, h - y)
            tile.width = tw
            tile.height = th
            ctx.imageSmoothingEnabled = w !== nw || h !== nh
            ctx.imageSmoothingQuality = 'high'
            ctx.drawImage(img, x * nw / w, y * nh / h, tw * nw / w, th * nh / h, 0, 0, tw, th)
            const pixels = ctx.getImageData(0, 0, tw, th).data
            for (let row = 0; row < th; row++) {
              imgData.data.set(pixels.subarray(row * tw * 4, (row + 1) * tw * 4), ((y + row) * w + x) * 4)
            }
          }
        }
        tile.width = tile.height = 1
        // 校准预览单独缩小；网格坐标与识别始终使用上面的原图尺寸。
        const previewScale = Math.min(1, 2048 / Math.max(w, h))
        const cv = document.createElement('canvas')
        cv.width = Math.max(1, Math.round(w * previewScale))
        cv.height = Math.max(1, Math.round(h * previewScale))
        const previewCtx = cv.getContext('2d')
        if (!previewCtx) return null
        previewCtx.drawImage(img, 0, 0, cv.width, cv.height)
        return { imgData, canvas: cv }
      } finally {
        URL.revokeObjectURL(url)
      }
    },
    [],
  )

  const readChart = useCallback((image: ImageData, spec: GridSpec) => {
    const key = JSON.stringify(spec)
    const cached = recognitionCacheRef.current
    if (cached?.image === image && cached.key === key) return cached.value
    // 字符先独立解码，体系/图例限制由 buildPattern 检查，不能强迫字形变成唯一候选。
    const value = recognizeChart(image, spec)
    recognitionCacheRef.current = { image, key, value }
    return value
  }, [])

  const loadFile = useCallback(
    async (file: File, existing?: { id: string; name: string; settings: ProjectSettings }) => {
      setBusy(true)
      setError(null)
      setNotice(null)
      setPreview(null)
      try {
        const prepared = await prepareImageData(file)
        if (!prepared) throw new Error('图片解码失败或尺寸为 0')
        const { imgData, canvas: cv } = prepared
        const w = imgData.width
        const h = imgData.height

        imgCanvasRef.current = cv
        imgDataRef.current = imgData
        recognitionCacheRef.current = null
        setFileName(file.name)
        setImageHash(hashImage(imgData, file.name))
        setImageToken((x) => x + 1)

        // 原图留着用于「重新校准」；封面用识别结果渲染（见 patternThumbDataUrl）
        if (existing) {
          setCurrentProjectId(existing.id)
          setProjectName(existing.name)
          setCodeText(existing.settings.codeText ?? '')
          setAllowedIndices(existing.settings.allowedIndices ?? null)
          setPaletteSystem(existing.settings.paletteSystem ?? 'MARD221')
        } else if (!currentProjectId) {
          setProjectName(nextProjectName(projects))
          setCodeText('')
          setAllowedIndices(null)
        }
        setCodeNote(null)
        setAllowForeignColors(false)
        pendingImageRef.current = { blob: file, name: file.name }

        const det = detectGrid(imgData)
        const g = clampGrid(det.grid, w, h)
        setGrid(g)
        const conf = Math.round(det.confidence * 100)
        setDetectHint(
          `自动识别：格距 ${det.grid.cellW.toFixed(2)} × ${det.grid.cellH.toFixed(2)} px · ` +
            `${g.cols} 列 × ${g.rows} 行 · 置信度 ${conf}%` +
            (conf < 45 ? '（偏低，请手动校准网格线）' : ''),
        )
        setDetectDebug(det.debug ?? null)
        setDetectConfidence(det.confidence)

        setPattern(null)
        setDone(new Set())
        setHistory([])
        setExcluded(new Set())
        setSelected(null)
        setStepIndex(0)
        setMode('browse')
        setElapsedSec(0)
        setFocusRequest(null)
        setStage('calibrate')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [prepareImageData, currentProjectId, projects],
  )

  /* ------------------------- 校准时的实时预览 ------------------------- */

  useEffect(() => {
    if (stage !== 'calibrate') return
    const imgData = imgDataRef.current
    if (!imgData) return
    const t = setTimeout(() => {
      try {
        const allowed = allowedIndices ?? indicesInSystem(paletteSystem)
        const { pattern: p } = buildPattern(imgData, grid, {
          name: fileName,
          imageUrl: '',
          imageHash: 'preview',
          dropBackground: true,
          allowed,
          textRecognition: readChart(imgData, grid),
        })
        const counts = rawCounts(p)
        let blank = blankCount(p)
        setPreview({ colors: counts.size, beads: p.cells.length - blank, blank })
      } catch {
        setPreview(null)
      }
    }, 260)
    return () => clearTimeout(t)
  }, [stage, grid, fileName, paletteSystem, allowedIndices, readChart])

  const autoDetect = useCallback(() => {
    const imgData = imgDataRef.current
    if (!imgData) return
    const det = detectGrid(imgData)
    setGrid(clampGrid(det.grid, imgData.width, imgData.height))
    const conf = Math.round(det.confidence * 100)
    setDetectHint(
      `自动识别：格距 ${det.grid.cellW.toFixed(2)} × ${det.grid.cellH.toFixed(2)} px · ` +
        `${det.grid.cols} 列 × ${det.grid.rows} 行 · 置信度 ${conf}%`,
    )
    setDetectDebug(det.debug ?? null)
  }, [])

  const applyCellCount = useCallback((cols: number, rows: number) => {
    const imgData = imgDataRef.current
    if (!imgData) return
    const res = gridFromCellCount(imgData, cols, rows)
    if (!res) {
      setError('按格数校准失败：没能圈出图案主体，请手动调整格宽与原点。')
      return
    }
    const g = res.grid
    setGrid(clampGrid(g, imgData.width, imgData.height))
    setDetectHint(
      `按标注格数校准：${g.cols} 列 × ${g.rows} 行 · 格距 ${g.cellW.toFixed(2)} × ${g.cellH.toFixed(2)} px · ` +
        `原点 ${g.offsetX.toFixed(1)},${g.offsetY.toFixed(1)}`,
    )
    setDetectDebug(
      `图案主体包围盒（已裁掉纯色标尺/边框）：x ${res.box.x0}..${res.box.x1} y ${res.box.y0}..${res.box.y1}` +
        `（${res.box.x1 - res.box.x0 + 1}×${res.box.y1 - res.box.y0 + 1}px）\n` +
        `格距 = 包围盒尺寸 ÷ 标注格数 = ${res.qX.toFixed(2)} × ${res.qY.toFixed(2)} px\n` +
        (res.snapped ? `吸附到分区线：${res.snapped}\n` : '未检测到加粗分区线，未做吸附\n') +
        `相位（色块边界剖面精修）：${res.px.toFixed(2)}, ${res.py.toFixed(2)}`,
    )
  }, [])

  /**
   * 按图纸图例的色号收窄色板并重新识别。
   * 实拍图纸格子小、格内又印满色号，逐格采样难免有噪声，
   * 把候选颜色限制在图例列出的那些色号上，能大幅减少「认成相邻色号」。
   */
  const applyColorCodes = useCallback(() => {
    const imgData = imgDataRef.current
    if (!imgData || !pattern) return
    const text = codeText.trim()
    const resolved = text
      ? resolveColorCodes(text, brand)
      : { indices: [] as number[], unknown: [] as string[], crossBrand: [] as string[] }
    const indices = resolved
    if (text && indices.indices.length === 0) {
      setCodeNote('没有识别出任何有效色号，检查一下格式（色号之间用空格或逗号分隔）。')
      return
    }
    const allowed = indices.indices.length > 0 ? indices.indices : null
    // 图例给出的是「这张图纸用到的色号」；色号体系给出的是「这套色号表里有哪些」。
    // 两者取交集 —— 粘了图例却选了不对的体系时，明确报出哪些色号对不上。
    let outsideSystem: string[] = []
    let effective = allowed ?? indicesInSystem(paletteSystem)
    if (allowed) {
      const cut = intersectWithSystem(allowed, paletteSystem)
      if (cut.kept.length > 0) {
        effective = cut.kept
        outsideSystem = cut.outside.map((i) => codeOf(i, brand))
      } else {
        setCodeNote('输入的色号均不在当前色号体系内，请先选择图纸对应的色号体系。')
        return
      }
    }
    const hadProgress = done.size > 0
    const res = buildPattern(imgData, pattern.grid, {
      name: fileName,
      imageUrl: '',
      imageHash: imageHash || pattern.id,
      dropBackground: treatBlankAsEmpty,
      allowed: effective,
      allowForeignColors,
      textRecognition: readChart(imgData, pattern.grid),
    })
    setPattern(res.pattern)
    setAllowedIndices(allowed ? effective : null)
    setDone(new Set())
    setHistory([])
    const parts: string[] = []
    parts.push(
      allowed
        ? `已按「${brand}」把色板收窄到 ${effective ? effective.length : 0} 个候选色号` +
            `（色号体系 ${paletteSystem === 'MARD221' ? '221' : '291'}）`
        : `已按色号体系 ${paletteSystem === 'MARD221' ? 'MARD 221' : 'MARD 291'} ` +
            `收窄到 ${indicesInSystem(paletteSystem).length} 个候选色号`,
    )
    if (outsideSystem.length > 0) {
      parts.push(
        `⚠ 这些色号不在当前色号体系里，已忽略：${outsideSystem.join(' ')}` +
          `（图纸如果确实用到它们，说明它属于更全的那套体系，请把下面的「色号体系」改过去）`,
      )
    }
    if (indices.crossBrand.length > 0) {
      parts.push(`这些色号在「${brand}」里没有，按其它体系理解：${indices.crossBrand.join(' ')}`)
    }
    if (indices.unknown.length > 0) parts.push(`完全无法识别的色号：${indices.unknown.join(' ')}`)
    if (effective && res.unmatched > 0) {
      parts.push(
        res.foreign > 0
          ? `有 ${res.unmatched} 格与候选色号都差得较远，其中 ${res.foreign} 格用了图例之外的颜色`
          : `有 ${res.unmatched} 格与候选色号都差得较远，已按最接近的图例色号处理` +
            `（若图例确实抄漏了色号，勾选下面的「允许图例之外的颜色」）`,
      )
    }
    if (hadProgress) parts.push('重新识别会改变逐格颜色，已清空拼豆进度')
    setCodeNote(parts.join('；'))

    // 必须落库：否则回首页再打开时，色板约束会丢，颜色数又变回未约束的结果
    const pid = currentProjectId
    if (pid) {
      void (async () => {
        try {
          await replaceProjectPattern(
            pid,
            {
              id: pid,
              imageHash: imageHash || pattern.id,
              imageName: fileName,
              imageW: res.pattern.imageW,
              imageH: res.pattern.imageH,
              grid: { ...res.pattern.grid },
              cells: res.pattern.cells,
              blank: res.pattern.blank,
              purity: res.pattern.purity,
              second: res.pattern.second,
              margin: res.pattern.margin,
              flags: res.pattern.flags,
              textConfidence: res.pattern.textConfidence,
              recognition: res.pattern.recognition,
              pageBg: res.pattern.pageBg,
            },
            // 色板约束存在 settings 里，和识别结果一起更新（封面也要跟着重画）
            { ...settingsFromState(), allowedIndices: allowed ? effective : null, codeText: text },
            0,
            false,
            patternThumbDataUrl(res.pattern.cells, res.pattern.grid.cols, res.pattern.grid.rows),
          )
          await refreshProjects()
        } catch (e) {
          setNotice('色号约束已应用到当前视图，但没能保存到项目：' + (e instanceof Error ? e.message : String(e)))
        }
      })()
    }
  }, [
    codeText,
    brand,
    pattern,
    fileName,
    imageHash,
    done.size,
    treatBlankAsEmpty,
    currentProjectId,
    settingsFromState,
    refreshProjects,
    paletteSystem,
    allowForeignColors,
    readChart,
  ])

  const confirmCalibration = useCallback(() => {
    const imgData = imgDataRef.current
    if (!imgData) {
      setError('没有可用的图像数据，请重新上传图纸')
      return
    }
    setBusy(true)
    setError(null)
    setTimeout(() => {
      void (async () => {
        try {
          const candidates = allowedIndices ?? indicesInSystem(paletteSystem)
          const res = buildPattern(imgData, grid, {
            name: fileName,
            imageUrl: '',
            imageHash,
            dropBackground: true,
            // 没粘图例时也不能放开到全色板：先按色号体系收窄。
            // 用户报的「识别出原图没有的 P1、R8」正是这里放开了 291 色导致的 ——
            // 他的图纸是 MARD 221，那 70 个扩展色号在图纸里根本不存在。
            allowed: candidates,
            textRecognition: readChart(imgData, grid),
          })
          setPattern(res.pattern)
          setDone(new Set())
          setHistory([])
          setStepIndex(0)
          setElapsedSec(0)
          setMode('browse')
          const counts = rawCounts(res.pattern)
          let best = -1
          let bestN = -1
          for (const [k2, v] of counts) {
            if (v > bestN) {
              bestN = v
              best = k2
            }
          }
          setSelected(best >= 0 ? best : null)
          setStage('work')
          setFitToken((x) => x + 1)

          /* ---- 落库成一个项目：图纸原图 + 识别结果 + 参数 + 进度 ---- */
          const settings = settingsFromState()
          const patternRecord: ProjectPattern = {
            id: currentProjectId ?? newId(),
            imageHash,
            imageName: fileName,
            imageW: res.pattern.imageW,
            imageH: res.pattern.imageH,
            grid: { ...res.pattern.grid },
            cells: res.pattern.cells,
            blank: res.pattern.blank,
            purity: res.pattern.purity,
            second: res.pattern.second,
            margin: res.pattern.margin,
            flags: res.pattern.flags,
            textConfidence: res.pattern.textConfidence,
            recognition: res.pattern.recognition,
            pageBg: res.pattern.pageBg,
          }
          const pending = pendingImageRef.current
          if (currentProjectId) {
            await replaceProjectPattern(
              currentProjectId,
              patternRecord,
              settings,
              detectConfidence,
              false,
              patternThumbDataUrl(res.pattern.cells, res.pattern.grid.cols, res.pattern.grid.rows),
            )
            if (pending) await saveProjectImage(currentProjectId, pending.blob)
            await renameProjectStore(currentProjectId, projectName)
            setNotice('已按新的校准结果更新项目。')
          } else {
            const id = await createProject({
              name: projectName.trim() || nextProjectName(projects),
              pattern: patternRecord,
              settings,
              image: pending?.blob ?? null,
              thumb: patternThumbDataUrl(res.pattern.cells, res.pattern.grid.cols, res.pattern.grid.rows),
              confidence: detectConfidence,
            })
            setCurrentProjectId(id)
            setNotice('项目已保存，之后随时可以从首页继续拼。')
          }
          await refreshProjects()

          if (res.backgroundCells > 0) {
            setNotice(
              `自动把 ${res.backgroundCells} 个贴边空白格当成「不拼」。` +
                `如果里面其实有白色豆子，可在右侧「显示」里改成按颜色拼。`,
            )
          }
        } catch (e) {
          setError('识别失败：' + (e instanceof Error ? e.message : String(e)))
        } finally {
          setBusy(false)
        }
      })()
    }, 20)
  }, [
    grid,
    fileName,
    imageHash,
    allowedIndices,
    currentProjectId,
    projectName,
    projects,
    detectConfidence,
    settingsFromState,
    refreshProjects,
    paletteSystem,
    readChart,
  ])

  /* ------------------------- 示例图纸 / URL 参数 ------------------------- */

  const loadDemo = useCallback((name: string) => {
    setDemoName(name)
  }, [])

  // 挂载时读 ?demo=a&auto=1（auto=1 表示自动完成识别，便于截图/演示）
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const d = p.get('demo')
    if (!d) return
    autoConfirmRef.current = p.get('auto') === '1'
    setDemoName(d)
  }, [])

  useEffect(() => {
    if (!demoName) return
    const name = demoName
    setDemoName(null)
    void (async () => {
      try {
        const file = name.includes('.') ? name : `${name}.png`
        const res = await fetch(assetUrl(`samples/${file}`))
        if (!res.ok) throw new Error(`找不到示例图纸：${file}`)
        const blob = await res.blob()
        await loadFile(new File([blob], `示例图纸-${file}`, { type: blob.type || 'image/png' }))
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [demoName, loadFile])

  useEffect(() => {
    if (stage === 'calibrate' && autoConfirmRef.current) {
      autoConfirmRef.current = false
      confirmCalibration()
    }
  }, [stage, confirmCalibration])

  /* ------------------------- 派生数据 ------------------------- */

  const plan = useMemo(
    () => (pattern ? derivePlan(pattern, excluded, { treatBlankAsEmpty }) : null),
    [pattern, excluded, treatBlankAsEmpty],
  )
  const raw = useMemo(() => (pattern ? rawCounts(pattern) : new Map<number, number>()), [pattern])
  const blankCells = useMemo(() => (pattern ? blankCount(pattern) : 0), [pattern])

  /**
   * 采样纯度偏低、值得人工核对的格子。
   *
   * 不能用一个固定阈值：高密度图纸（格子小、格内印满色号）**每一格**的
   * 主色占比都偏低，固定阈值会把 10816 格里的一万多格全标出来，
   * 整块画布被提示标记淹没，连分区线都看不见了。
   * 所以改成「取最差的一小撮」：按纯度排序取最差 2%（最多 400 个），
   * 并且纯度还得低于 0.45 才算「不确定」。
   */
  const lowCells = useMemo(() => {
    if (!pattern) return []
    // 判据已从「采样纯度低」改成「色号歧义 + 采样纯度低」，见 lowConfidenceCells 的说明：
    // 高纯度不代表色号对 —— 一个格子可以颜色很纯，却同时贴近两个色号。
    return lowConfidenceCells(pattern, pattern.cells.length)
  }, [pattern])

  /** 按原因分类，给「识别质量」面板显示 —— 让「哪里需要核对」有明确理由 */
  const lowReasons = useMemo(() => {
    const out = { ambiguous: 0, lowPurity: 0, background: 0, text: 0, conflict: 0 }
    if (!pattern?.flags) return out
    for (let i = 0; i < pattern.flags.length; i++) {
      if (pattern.cells[i] === EMPTY || pattern.blank[i]) continue
      const f = pattern.flags[i]
      if (f & CELL_CLOSE_COLORS) out.ambiguous++
      if (f & CELL_LOW_PURITY) out.lowPurity++
      if (f & CELL_BACKGROUND) out.background++
      if (f & CELL_TEXT_UNCERTAIN) out.text++
      if (f & CELL_TEXT_CONFLICT) out.conflict++
    }
    return out
  }, [pattern])
  const lowSet = useMemo(() => new Set(lowCells), [lowCells])
  const steps = useMemo(
    () => (plan && pattern ? buildSteps(plan, pattern.grid, orderOpts, brand) : []),
    [plan, pattern, orderOpts, brand],
  )

  const doneCounts = useMemo(() => {
    const m = new Map<number, number>()
    if (!plan) return m
    for (const i of done) {
      if (i < 0 || i >= plan.cells.length) continue
      const v = plan.cells[i]
      if (v === EMPTY) continue
      m.set(v, (m.get(v) ?? 0) + 1)
    }
    return m
  }, [done, plan])

  const totalDone = useMemo(() => {
    if (!plan) return 0
    let n = 0
    for (const i of done) {
      if (i >= 0 && i < plan.cells.length && plan.cells[i] !== EMPTY) n++
    }
    return n
  }, [done, plan])

  const currentStep = steps[stepIndex] ?? null
  const cols = pattern?.grid.cols ?? 0
  const rows = pattern?.grid.rows ?? 0

  const pendingInColor = useMemo(() => {
    if (!currentStep) return [] as number[]
    return currentStep.cells.filter((i) => !done.has(i))
  }, [currentStep, done])

  /* ---- 色块（区域）选择 ---- */

  const colorRegions = currentStep?.regions ?? []
  const regionDone = useMemo(() => regionDoneFlags(colorRegions, done), [colorRegions, done])

  const autoRegionIndex = useMemo(
    () => pickRegionIndex(colorRegions, done, orderOpts.regionOrder, refCell, cols),
    [colorRegions, done, orderOpts.regionOrder, refCell, cols],
  )
  // 手动选中的色块优先，但它一旦拼完就交还给自动选择
  const regionIndex =
    regionPick !== null && regionPick < colorRegions.length && !regionDone[regionPick]
      ? regionPick
      : autoRegionIndex
  const currentRegion = regionIndex >= 0 ? (colorRegions[regionIndex] ?? null) : null
  const currentRegionPending = useMemo(
    () => (currentRegion ? regionPendingCells(currentRegion, done) : []),
    [currentRegion, done],
  )
  const doneRegions = useMemo(() => regionDone.filter(Boolean).length, [regionDone])

  const targetCell =
    mode !== 'guide'
      ? null
      : guideUnit === 'region'
        ? (currentRegionPending[0] ?? pendingInColor[0] ?? null)
        : (pendingInColor[0] ?? null)

  const targetPos =
    targetCell !== null && cols > 0
      ? { row: Math.floor(targetCell / cols), col: targetCell % cols }
      : null

  const blobCells = useMemo(() => {
    if (mode !== 'guide') return null
    if (currentRegion) return currentRegion.cells
    if (targetCell === null || !plan || cols <= 0) return null
    return blobAt(plan.cells, cols, rows, targetCell)
  }, [mode, currentRegion, targetCell, plan, cols, rows])
  const effectiveSelected = mode === 'guide' && currentStep ? currentStep.paletteIndex : selected

  /* ------------------------- 自动推进到下一种颜色 ------------------------- */

  useEffect(() => {
    if (mode !== 'guide' || !autoAdvance) return
    if (pendingInColor.length > 0) return
    for (let k = 1; k <= steps.length; k++) {
      const ni = (stepIndex + k) % steps.length
      const s = steps[ni]
      if (s && s.cells.some((i) => !done.has(i))) {
        setStepIndex(ni)
        return
      }
    }
  }, [mode, autoAdvance, pendingInColor.length, stepIndex, steps, done])

  /* ------------------------- 进度操作 ------------------------- */

  const pushHistory = useCallback((entry: HistoryEntry) => {
    setHistory((h) => [...h, entry])
  }, [])

  const markCells = useCallback(
    (indices: number[]) => {
      const filtered = indices.filter((i) => i >= 0 && !done.has(i))
      if (filtered.length === 0) return
      setDone((d) => {
        const n = new Set(d)
        for (const i of filtered) n.add(i)
        return n
      })
      pushHistory({ op: 'add', cells: filtered })
      setRefCell(filtered[filtered.length - 1])
    },
    [done, pushHistory],
  )

  const unmarkCells = useCallback(
    (indices: number[]) => {
      const filtered = indices.filter((i) => done.has(i))
      if (filtered.length === 0) return
      const next = new Set(done)
      for (const i of filtered) next.delete(i)
      setDone(next)
      pushHistory({ op: 'remove', cells: filtered })
    },
    [done, pushHistory],
  )

  /** 拼好当前色块（默认操作） */
  const markRegion = useCallback(() => {
    if (currentRegionPending.length > 0) {
      markCells(currentRegionPending)
      setRegionPick(null)
    }
  }, [currentRegionPending, markCells])

  /** 按单粒模式：拼好下一粒 */
  const markCurrent = useCallback(() => {
    if (targetCell !== null) markCells([targetCell])
  }, [targetCell, markCells])

  const markColor = useCallback(() => {
    markCells(pendingInColor)
    setRegionPick(null)
  }, [pendingInColor, markCells])

  /**
   * 点画布：把那一格所在的整块标完（已完成的块再点一次则取消）。
   * 这就是参考项目的交互 —— 一片区域一片区域地拼。
   */
  const toggleRegionAt = useCallback(
    (cellIndex: number) => {
      if (!plan || cols <= 0) return
      const blob = blobAt(plan.cells, cols, rows, cellIndex)
      if (blob.length === 0) return
      const allDone = blob.every((i) => done.has(i))
      const k = colorRegions.findIndex((r) => r.cells.includes(cellIndex))
      if (allDone) {
        unmarkCells(blob)
        if (k >= 0) setRegionPick(k)
      } else {
        markCells(blob)
        setRegionPick(null)
      }
      setRefCell(cellIndex)
    },
    [plan, cols, rows, done, colorRegions, markCells, unmarkCells],
  )

  const undo = useCallback(() => {
    if (history.length === 0) return
    const last = history[history.length - 1]
    const next = new Set(done)
    if (last.op === 'add') for (const i of last.cells) next.delete(i)
    else for (const i of last.cells) next.add(i)
    setDone(next)
    setHistory((h) => h.slice(0, -1))
    // 撤销只往回退，绝不往前走：如果前面某种颜色又变得没拼完，
    // 就把指引拉回那种颜色（「整块完成」会自动跳到下一种颜色，
    // 撤销时必须跟着退回来，否则会在错误的颜色上继续操作）
    for (let i = 0; i < stepIndex; i++) {
      const s = steps[i]
      if (s && s.cells.some((c) => !next.has(c))) {
        setStepIndex(i)
        setSelected(s.paletteIndex)
        break
      }
    }
    setRegionPick(null)
  }, [history, done, stepIndex, steps])

  const restartColor = useCallback(() => {
    if (!currentStep) return
    const toRemove = currentStep.cells.filter((i) => done.has(i))
    if (toRemove.length === 0) return
    setDone((d) => {
      const n = new Set(d)
      for (const i of toRemove) n.delete(i)
      return n
    })
    pushHistory({ op: 'remove', cells: toRemove })
    setRegionPick(null)
  }, [currentStep, done, pushHistory])

  const resetAllProgress = useCallback(() => {
    setDone(new Set())
    setHistory([])
    setRegionPick(null)
    setRefCell(null)
  }, [])

  /** 切换颜色 / 手动跳色块时，清掉手动选择，交回自动挑块 */
  const gotoStep = useCallback(
    (i: number) => {
      if (i < 0 || i >= steps.length) return
      setStepIndex(i)
      setSelected(steps[i].paletteIndex)
      setRegionPick(null)
    },
    [steps],
  )

  useEffect(() => {
    setRegionPick(null)
  }, [stepIndex])

  /* ------------------------- 选中颜色 / 定位 ------------------------- */

  const selectColor = useCallback(
    (idx: number | null) => {
      setSelected(idx)
      if (idx === null) return
      if (mode === 'guide') {
        const si = steps.findIndex((s) => s.paletteIndex === idx)
        if (si >= 0) gotoStep(si)
      }
      if (focusOnColor && plan && cols > 0) {
        let minR = Infinity
        let minC = Infinity
        let maxR = -1
        let maxC = -1
        for (let i = 0; i < plan.cells.length; i++) {
          if (plan.cells[i] !== idx) continue
          const r = Math.floor(i / cols)
          const c = i - r * cols
          if (r < minR) minR = r
          if (c < minC) minC = c
          if (r > maxR) maxR = r
          if (c > maxC) maxC = c
        }
        if (maxR >= 0) {
          setFocusRequest({
            index: minR * cols + minC,
            token: nextFocusToken(),
            bounds: { minR, minC, maxR, maxC },
          })
        }
      }
    },
    [mode, steps, focusOnColor, plan, cols, nextFocusToken],
  )

  const locateTarget = useCallback(() => {
    if (targetCell === null) return
    setFocusRequest({ index: targetCell, token: nextFocusToken() })
  }, [targetCell, nextFocusToken])

  /* ------------------------- 键盘快捷键 ------------------------- */

  useEffect(() => {
    if (stage !== 'work' || (isMobile && sheetExpanded)) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('input, select, textarea')) return
      if (t?.closest('button') && (e.code === 'Space' || e.key === 'Enter')) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (mode === 'guide') {
          if (guideUnit === 'region') markRegion()
          else markCurrent()
        }
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
        return
      }
      if (mode === 'guide') {
        if (e.key === 'Enter') {
          gotoStep(stepIndex + 1)
        } else if (e.key === 'b') {
          markRegion()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stage, mode, markCurrent, undo, markRegion, guideUnit, stepIndex, steps.length, gotoStep, isMobile, sheetExpanded])

  /* ------------------------- 持久化 ------------------------- */

  // 串行写入的每一轮都读取最新状态，不能重复使用开始保存时捕获的旧 done。
  const progressSnapshotRef = useRef<{
    pattern: Pattern; projectId: string; done: Set<number>; excluded: Set<number>; total: number
  } | null>(null)
  if (pattern && currentProjectId) {
    progressSnapshotRef.current = { pattern, projectId: currentProjectId, done, excluded, total: plan?.total ?? 0 }
  }

  /**
   * 进度保存。
   * done 每次点格子都会变，所以这里做两层节流：
   *  1) 700ms 防抖，连续点同一块不会每格都写一次；
   *  2) 串行化 —— 上一次还没写完就只记一个「待写」标记，写完立刻再写一次最新值，
   *     避免并发写导致旧数据覆盖新数据。
   */
  const flushProgress = useCallback(async () => {
    const st = saveStateRef.current
    if (st.saving) {
      st.queued = true
      return
    }
    if (!progressSnapshotRef.current) return
    st.saving = true
    try {
      do {
        st.queued = false
        const latest = progressSnapshotRef.current
        if (!latest) break
        const flags = new Uint8Array(latest.pattern.cells.length)
        for (const i of latest.done) {
          if (i >= 0 && i < flags.length) flags[i] = 1
        }
        await saveProjectProgress(
          latest.projectId,
          flags,
          latest.pattern.cells,
          latest.pattern.blank,
          latest.excluded,
          latest.total,
        )
      } while (saveStateRef.current.queued)
    } catch (e) {
      if (!warnedSaveRef.current) {
        warnedSaveRef.current = true
        setNotice(
          '进度没能保存到本机（浏览器存储可能不可用或已满），当前进度仍然可用：' +
            (e instanceof Error ? e.message : String(e)),
        )
      }
    } finally {
      st.saving = false
    }
  }, [])

  useEffect(() => {
    if (stage !== 'work' || !pattern || !currentProjectId) return
    const t = setTimeout(() => {
      void flushProgress()
    }, 700)
    return () => clearTimeout(t)
  }, [stage, pattern, currentProjectId, done, excluded, flushProgress])

  /** 参数变化（品牌 / 拼块顺序 / 显示开关…）单独落库，不重写识别数据 */
  useEffect(() => {
    if (!currentProjectId || stage === 'upload') return
    const t = setTimeout(() => {
      void saveProjectSettings(currentProjectId, settingsFromState(), plan?.total)
    }, 800)
    return () => clearTimeout(t)
  }, [currentProjectId, stage, settingsFromState, plan?.total])

  /** 离开页面/切到后台前把进度写下去 */
  useEffect(() => {
    if (stage !== 'work') return
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flushProgress()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      void flushProgress()
    }
  }, [stage, flushProgress])

  /* ------------------------- 打开 / 管理项目 ------------------------- */

  /**
   * 打开一个已保存的项目：恢复识别结果、全部参数、进度。
   * 识别数据（cells/purity）比较重，只有打开时才读。
   */
  const openProject = useCallback(
    async (id: string) => {
      setBusy(true)
      setError(null)
      try {
        recognitionCacheRef.current = null
        imgDataRef.current = null
        imgCanvasRef.current = null
        const [rec, doneBits, meta] = await Promise.all([
          getProjectPattern(id),
          getProjectProgress(id),
          getProjectMeta(id),
        ])
        if (!rec || !meta) {
          setError('这个项目的识别数据不见了，可能已被清理。请删除后重新上传图纸。')
          return
        }
        const n = rec.grid.cols * rec.grid.rows
        const patternObj: Pattern = {
          id: rec.imageHash,
          name: meta.name,
          imageW: rec.imageW,
          imageH: rec.imageH,
          grid: { ...rec.grid },
          cells: rec.cells,
          blank: rec.blank,
          purity: rec.purity && rec.purity.length === rec.cells.length ? rec.purity : new Float32Array(n),
          // 旧项目没有这三个字段 —— 置空即可，界面会降级到只看 purity
          second: rec.second && rec.second.length === rec.cells.length ? rec.second : undefined,
          margin: rec.margin && rec.margin.length === rec.cells.length ? rec.margin : undefined,
          flags: rec.flags && rec.flags.length === rec.cells.length ? rec.flags : undefined,
          textConfidence: rec.textConfidence?.length === rec.cells.length ? rec.textConfidence : undefined,
          recognition: rec.recognition,
          pageBg: rec.pageBg,
          imageUrl: '',
          createdAt: meta.createdAt,
        }
        const s = meta.settings
        setPattern(patternObj)
        setCurrentProjectId(id)
        setProjectName(meta.name)
        setImageHash(rec.imageHash)
        setFileName(rec.imageName || meta.name)
        setBrand(s.brand)
        setExcluded(new Set(s.excluded))
        setCodeText(s.codeText ?? '')
        setAllowedIndices(s.allowedIndices ?? null)
        // 旧项目没有这个字段 → 按 221 兜底（零售最常见，也最保守：不会凭空造出扩展色号）
        setPaletteSystem(s.paletteSystem === 'MARD291' ? 'MARD291' : 'MARD221')
        setTreatBlankAsEmpty(s.treatBlankAsEmpty)
        setDimMode(s.dimMode)
        setShowGrid(s.showGrid)
        setShowCodes(s.showCodes)
        setShowSectionLines(s.showSectionLines)
        setSectionInterval(s.sectionInterval)
        setShowExcluded(s.showExcluded)
        setShowLowConf(s.showLowConf)
        setOrderOpts({
          colorOrder: s.orderOpts?.colorOrder ?? 'countDesc',
          cellOrder:
            s.orderOpts?.cellOrder === 'row' || s.orderOpts?.cellOrder === 'nearest'
              ? s.orderOpts.cellOrder
              : 'snake',
          regionOrder: s.orderOpts?.regionOrder ?? 'flow',
        })
        const d = new Set<number>()
        if (doneBits) {
          for (let i = 0; i < doneBits.length && i < patternObj.cells.length; i++) {
            if (doneBits[i]) d.add(i)
          }
        }
        setDone(d)
        setHistory([])
        setStepIndex(0)
        setSelected(null)
        setMode('browse')
        setElapsedSec(0)
        setStage('work')
        setFitToken((x) => x + 1)
        setNotice(
          meta.doneCount > 0
            ? `继续「${meta.name}」：已拼 ${meta.doneCount.toLocaleString()} / ${meta.total.toLocaleString()} 粒。`
            : `开始「${meta.name}」。`,
        )

        /*
         * 把图纸原图也解码成 ImageData。
         * 工作台里「按图纸图例约束色板」要重新采样，没有 imgData 就点不动；
         * 这里必须校验尺寸和当初识别时一致，否则网格坐标对不上，
         * 重新采样会整片错位（宁可不加载，让用户走「重新校准」）。
         */
        try {
          const blob = await getProjectImage(id)
          if (blob) {
            const prepared = await prepareImageData(blob, { width: rec.imageW, height: rec.imageH })
            if (prepared && prepared.imgData.width === rec.imageW && prepared.imgData.height === rec.imageH) {
              imgDataRef.current = prepared.imgData
              imgCanvasRef.current = prepared.canvas
            } else {
              imgDataRef.current = null
              imgCanvasRef.current = null
            }
          }
        } catch {
          imgDataRef.current = null
          imgCanvasRef.current = null
        }

        // 旧版本迁移过来的项目没有封面（那时还没存原图），打开时补画一张
        if (!meta.thumb) {
          const thumb = patternThumbDataUrl(
            rec.cells,
            rec.grid.cols,
            rec.grid.rows,
          )
          if (thumb) {
            await updateProjectThumb(id, thumb)
            void refreshProjects()
          }
        }
      } catch (e) {
        setError('打开项目失败：' + (e instanceof Error ? e.message : String(e)))
      } finally {
        setBusy(false)
      }
    },
    [prepareImageData],
  )

  /**
   * 重新校准已有项目：取出存下来的原图 Blob，走一遍上传+校准流程，
   * 确认时覆盖同一个项目（而不是新建）。
   */
  const recalibrateProject = useCallback(async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      const blob = await getProjectImage(id)
      const meta = await getProjectMeta(id)
      if (!blob) {
        setError('这个项目没有保存图纸原图（可能是从旧版本导入的），请重新上传图纸。')
        return
      }
      setCurrentProjectId(id)
      setProjectName(meta?.name ?? '项目')
      await loadFile(new File([blob], meta?.imageName || '图纸', { type: blob.type || 'image/png' }), meta ? {
        id, name: meta.name, settings: meta.settings,
      } : undefined)
    } catch (e) {
      setError('重新校准失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }, [loadFile])

  const handleRename = useCallback(
    async (id: string, name: string) => {
      await renameProjectStore(id, name)
      if (id === currentProjectId && name.trim()) setProjectName(name.trim())
      await refreshProjects()
    },
    [currentProjectId, refreshProjects],
  )

  const handleDelete = useCallback(
    async (id: string, name: string) => {
      await deleteProject(id)
      if (id === currentProjectId) {
        setCurrentProjectId(null)
        setPattern(null)
        setDone(new Set())
        setStage('upload')
      }
      await refreshProjects()
      setNotice(`已删除项目「${name}」。`)
    },
    [currentProjectId, refreshProjects],
  )

  const handleSetStatus = useCallback(
    async (id: string, status: ProjectStatus) => {
      await setProjectStatus(id, status)
      await refreshProjects()
    },
    [refreshProjects],
  )

  const handleCleanupFailed = useCallback(async () => {
    const ids = projects.filter((p) => p.status === 'failed').map((p) => p.id)
    if (ids.length === 0) return
    await deleteProjects(ids)
    if (currentProjectId && ids.includes(currentProjectId)) {
      setCurrentProjectId(null)
      setPattern(null)
      setDone(new Set())
      setStage('upload')
    }
    await refreshProjects()
    setNotice(`已清理 ${ids.length} 个标记为「识别失败」的项目。`)
  }, [projects, currentProjectId, refreshProjects])

  const startOver = useCallback(() => {
    clearSession()
    // 退出前把当前进度写下去
    void flushProgress()
    setPattern(null)
    setDone(new Set())
    setHistory([])
    setExcluded(new Set())
    setSelected(null)
    setCurrentProjectId(null)
    pendingImageRef.current = null
    setStage('upload')
    setNotice(null)
    setError(null)
    setPreview(null)
    void refreshProjects()
  }, [flushProgress, refreshProjects])

  const toggleExclude = useCallback(
    (idx: number) => {
      setExcluded((prev) => {
        const n = new Set(prev)
        if (n.has(idx)) {
          n.delete(idx)
        } else {
          if (raw.size - n.size <= 1) {
            setNotice('至少要保留一种颜色，已取消这次排除。')
            return prev
          }
          n.add(idx)
        }
        return n
      })
    },
    [raw.size],
  )

  /* ------------------------- 悬停信息 ------------------------- */

  const hoverInfo = useMemo(() => {
    if (hover === null || !plan || cols <= 0) return null
    if (hover < 0 || hover >= plan.cells.length) return null
    const v = plan.cells[hover]
    const r = Math.floor(hover / cols)
    const c = hover - r * cols
    return {
      row: r,
      col: c,
      value: v,
      label: v === EMPTY ? '空格' : `${codeOf(v, brand)} · ${PALETTE[v].hex}`,
    }
  }, [hover, plan, cols, brand])

  /* ------------------------- 渲染 ------------------------- */

  if (stage === 'upload') {
    return (
      <div className="app">
        <ProjectHome
          projects={projects}
          loading={projectsLoading}
          busy={busy}
          error={error}
          onFile={loadFile}
          onDemo={loadDemo}
          onOpen={(id) => void openProject(id)}
          onRecalibrate={(id) => void recalibrateProject(id)}
          onRename={(id, name) => void handleRename(id, name)}
          onDelete={(id, name) => void handleDelete(id, name)}
          onSetStatus={(id, st) => void handleSetStatus(id, st)}
          onCleanupFailed={() => void handleCleanupFailed()}
        />
      </div>
    )
  }

  if (stage === 'calibrate' && imgCanvasRef.current) {
    return (
      <div className="app">
        <header className="topbar">
          <Logo />
          <label className="name-field">
            项目名
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="例如：原神奥黛塔"
              title="默认是「项目N」，建议改成图纸的名字，方便以后在首页找"
            />
          </label>
          <span className="muted small topbar-file" title={fileName}>
            {fileName}
          </span>
          <div className="spacer" />
          <button type="button" className="btn" onClick={startOver}>
            返回首页
          </button>
        </header>
        {error && <div className="error-box wide">{error}</div>}
        <CalibrateView
          image={imgCanvasRef.current}
          imageSize={imgDataRef.current ? { width: imgDataRef.current.width, height: imgDataRef.current.height } : undefined}
          grid={grid}
          onChange={setGrid}
          onConfirm={confirmCalibration}
          onAutoDetect={autoDetect}
          onApplyCellCount={applyCellCount}
          onDetectedHint={detectHint}
          debugText={detectDebug}
          preview={preview}
          busy={busy}
          key={imageToken}
        />
      </div>
    )
  }

  if (!pattern || !plan) {
    return (
      <div className="app">
        <header className="topbar">
          <Logo />
          <div className="spacer" />
          <button type="button" className="btn" onClick={startOver}>
            重新选择图纸
          </button>
        </header>
        <div className="empty-state">
          {busy ? '正在识别…' : '还没有识别结果。'}
          {error && <div className="error-box">{error}</div>}
        </div>
      </div>
    )
  }

  const overallPct = plan.total > 0 ? (totalDone / plan.total) * 100 : 0

  /* ------------------------------------------------------------------ *
   * 桌面端和手机端共用的几块 UI。
   * 这里先建好元素再分别摆放，避免两套布局各抄一份 props ——
   * 抄一份就意味着以后加参数必然漏掉一边。
   * ------------------------------------------------------------------ */

  const colorListEl = (
    <ColorList
      plan={plan}
      raw={raw}
      brand={brand}
      selected={effectiveSelected}
      onSelect={selectColor}
      excluded={excluded}
      onToggleExclude={toggleExclude}
      doneCounts={doneCounts}
      orderMode={orderOpts.colorOrder}
      onOrderMode={(m) => setOrderOpts((o) => ({ ...o, colorOrder: m }))}
      showExcluded={showExcluded}
      onShowExcluded={setShowExcluded}
      blankCells={blankCells}
      onExportCsv={() => exportShoppingCsv(plan, brand, fileName, doneCounts)}
      onExportPng={() => exportShoppingPng(plan, brand, fileName, doneCounts)}
    />
  )

  const canvasEl = (
    <PatternCanvas
      cells={plan.cells}
      cols={pattern.grid.cols}
      rows={pattern.grid.rows}
      brand={brand}
      selected={effectiveSelected}
      dimMode={dimMode}
      done={done}
      targetCell={targetCell}
      blobCells={mode === 'guide' ? blobCells : null}
      warnCells={showLowConf ? lowSet : null}
      showGrid={showGrid}
      showCodes={showCodes}
      sectionInterval={sectionInterval}
      showSectionLines={showSectionLines}
      onCellClick={(i) => {
        const v = plan.cells[i]
        if (v === EMPTY) return
        if (mode === 'guide') {
          if (currentStep && v === currentStep.paletteIndex) {
            // 点一下就标完这一整块（参考项目的交互）
            toggleRegionAt(i)
          } else {
            // 点了别的颜色：跳到那个颜色的步骤，方便随时切换
            const si = steps.findIndex((s) => s.paletteIndex === v)
            if (si >= 0) {
              gotoStep(si)
              setRefCell(i)
            }
          }
        } else {
          selectColor(v)
        }
      }}
      onHoverCell={setHover}
      focusRequest={focusRequest}
      fitToken={fitToken}
    />
  )

  const progressEl = (
    <div className="stage-progress">
      <div className="bar tall">
        <div className="bar-fill" style={{ width: `${overallPct}%` }} />
      </div>
      <span className="muted small">
        {totalDone} / {plan.total} 粒 · {overallPct.toFixed(1)}% · 用时 {formatElapsed(elapsedSec)}
      </span>
    </div>
  )

  const guidePanelEl = (
    <>
      {mode === 'browse' && (
        <div className="callout">
          现在是「看颜色分布」模式。点击
          <button type="button" className="btn tiny primary inline" onClick={() => setMode('guide')}>
            开始拼豆指引
          </button>
          进入逐步指引。
        </div>
      )}
      <GuidePanel
        brand={brand}
        steps={steps}
        stepIndex={stepIndex}
        guideUnit={guideUnit}
        onGuideUnitChange={setGuideUnit}
        targetCell={targetCell}
        targetPos={targetPos}
        pendingInColor={pendingInColor.length}
        doneInColor={currentStep ? currentStep.count - pendingInColor.length : 0}
        regions={colorRegions}
        regionIndex={regionIndex}
        regionDone={regionDone}
        doneRegions={doneRegions}
        regionPending={currentRegionPending.length}
        regionOrder={orderOpts.regionOrder}
        onRegionOrderChange={(m) => setOrderOpts((o) => ({ ...o, regionOrder: m }))}
        onPickRegion={(k) => {
          setRegionPick(k)
          const reg = colorRegions[k]
          if (reg) setFocusRequest({ index: reg.cells[0], token: nextFocusToken() })
        }}
        totalDone={totalDone}
        totalBeads={plan.total}
        elapsed={formatElapsed(elapsedSec)}
        onMarkRegion={markRegion}
        onMarkCurrent={markCurrent}
        onMarkColor={markColor}
        onUndo={undo}
        canUndo={history.length > 0}
        onLocate={locateTarget}
        onSelectStep={(i) => {
          gotoStep(i)
          const s = steps[i]
          if (s && s.cells.length > 0) {
            const pending = s.cells.find((c) => !done.has(c))
            setFocusRequest({ index: pending ?? s.cells[0], token: nextFocusToken() })
          }
        }}
        onNextColor={() => gotoStep(Math.min(steps.length - 1, stepIndex + 1))}
        onPrevColor={() => gotoStep(Math.max(0, stepIndex - 1))}
        onRestartColor={restartColor}
        autoAdvance={autoAdvance}
        onAutoAdvanceChange={setAutoAdvance}
      />
    </>
  )

  const displayEl = (
    <DisplaySettings
      dimMode={dimMode}
      onDimMode={setDimMode}
      showGrid={showGrid}
      onShowGrid={setShowGrid}
      showCodes={showCodes}
      onShowCodes={setShowCodes}
      showSectionLines={showSectionLines}
      onShowSectionLines={setShowSectionLines}
      regionOrder={orderOpts.regionOrder}
      onRegionOrder={(m) => setOrderOpts((o) => ({ ...o, regionOrder: m }))}
      cellOrder={orderOpts.cellOrder}
      onCellOrder={(m) => setOrderOpts((o) => ({ ...o, cellOrder: m }))}
      treatBlankAsEmpty={treatBlankAsEmpty}
      onTreatBlankAsEmpty={setTreatBlankAsEmpty}
      blankCells={blankCells}
      sectionInterval={sectionInterval}
      onSectionInterval={setSectionInterval}
      focusOnColor={focusOnColor}
      onFocusOnColor={setFocusOnColor}
      onResetProgress={resetAllProgress}
    />
  )

  const infoEl = (
    <PatternInfo
      fileName={fileName}
      cols={pattern.grid.cols}
      rows={pattern.grid.rows}
      cellW={pattern.grid.cellW}
      cellH={pattern.grid.cellH}
      colorCount={plan.colors.length}
      beadTotal={plan.total}
      blankCells={blankCells}
      remapped={plan.remapped}
      recognition={pattern.recognition}
      codeText={codeText}
      onCodeText={setCodeText}
      onApplyCodes={applyColorCodes}
      allowedCount={allowedIndices ? allowedIndices.length : null}
      codeNote={codeNote}
      onClearCodes={() => {
        setCodeText('')
        setCodeNote(null)
      }}
      allowForeignColors={allowForeignColors}
      paletteSystem={paletteSystem}
      paletteSystems={PALETTE_SYSTEMS}
      onPaletteSystem={(id) => {
        setPaletteSystem(id)
        setCodeNote(
          id === 'MARD221'
            ? '已切到 MARD 221：候选色号只剩 A–H 和 M。识别不会再用到 P/Q/R/T/Y/ZG。'
            : '已切到 MARD 291：候选色号含 P/Q/R/T/Y/ZG 扩展的 70 色。图纸本身要用到它们时才选这套。',
        )
      }}
      onAllowForeignColors={(v) => {
        setAllowForeignColors(v)
        setCodeNote(
          v
            ? '已允许图例之外的颜色：与图例都差得较远的格子会回退到 291 色全色板，可能造出图纸上没有的色号。'
            : '已改为严格使用图例色号：与图例都差得较远的格子会归到最接近的那个。',
        )
      }}
      lowCount={lowCells.length}
      lowReasons={lowReasons}
      lowCursor={lowCursor}
      onJumpLow={() => {
        if (lowCells.length === 0) return
        const i = lowCells[lowCursor % lowCells.length]
        setLowCursor((k) => (k + 1) % lowCells.length)
        setShowLowConf(true)
        setFocusRequest({ index: i, token: nextFocusToken() })
        setSelected(plan.cells[i] === EMPTY ? null : plan.cells[i])
      }}
      showLowConf={showLowConf}
      onShowLowConf={setShowLowConf}
      onExportPattern={() =>
        exportRecognizedPattern(plan.cells, pattern.grid, brand, fileName, effectiveSelected)
      }
      onExportCsv={() => exportShoppingCsv(plan, brand, fileName, doneCounts)}
      onExportPng={() => exportShoppingPng(plan, brand, fileName, doneCounts)}
      onExportProgress={() => {
        const flags = new Uint8Array(pattern.cells.length)
        for (const i of done) if (i >= 0 && i < flags.length) flags[i] = 1
        const text = exportProgressText({
          version: 1,
          imageHash: imageHash || pattern.id,
          name: pattern.name,
          imageW: pattern.imageW,
          imageH: pattern.imageH,
          grid: pattern.grid,
          cells: i16ToBase64(pattern.cells),
          blank: encodeBitset(pattern.blank),
          pageBg: pattern.pageBg,
          brand,
          excluded: [...excluded],
          done: encodeBitset(flags),
          colorOrder: orderOpts.colorOrder,
          cellOrder: orderOpts.cellOrder,
          regionOrder: orderOpts.regionOrder,
          createdAt: pattern.createdAt,
          updatedAt: Date.now(),
        })
        downloadText(text, fileName.replace(/\.[^.]+$/, '') + '-进度.json')
      }}
      onRecalibrate={startOver}
    />
  )

  /* ------------------------- 手机端布局 ------------------------- */

  if (isMobile) {
    const curCode = currentStep ? codeOf(currentStep.paletteIndex, brand) : ''
    const curHex = currentStep ? PALETTE[currentStep.paletteIndex].hex : '#888888'
    return (
      <div className={`app mobile ${immersive ? 'is-immersive' : ''}`}>
        <header className="topbar m-topbar">
          <button type="button" className="m-icon-button" onClick={startOver} title="返回首页" aria-label="返回首页">
            <ArrowLeft size={19} aria-hidden="true" />
          </button>
          <div className="m-topbar-name" title={fileName}>
            {projectName || fileName}
          </div>
          <div className="spacer" />
          <div className="m-topbar-pct">{overallPct.toFixed(1)}%</div>
          <button
            type="button"
            className="m-icon-button m-focus-toggle"
            onClick={() => {
              setImmersive((v) => !v)
              setSheetExpanded(false)
            }}
            aria-label={immersive ? '退出专注模式' : '进入专注模式'}
            title={immersive ? '退出专注模式' : '进入专注模式'}
          >
            {immersive ? <Minimize2 size={19} aria-hidden="true" /> : <Maximize2 size={19} aria-hidden="true" />}
          </button>
        </header>

        {notice && (
          <div className="notice-bar">
            <span className="m-notice-text">{notice}</span>
            <button type="button" className="m-icon-button" onClick={() => setNotice(null)} aria-label="关闭通知" title="关闭通知">
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        )}
        {error && <div className="error-box wide">{error}</div>}

        <main className="m-workspace">
          <section className="stage">
            <div className="stage-bar">
              <span className="m-chart-position muted small">
                {immersive && mode === 'guide' && currentStep ? (
                  <>
                    <i className="m-current-swatch" style={{ background: curHex }} />
                    {curCode} · {guideUnit === 'cell' ? (targetCell === null ? 0 : 1) : currentRegionPending.length} 粒待拼
                  </>
                ) : (
                  hoverInfo
                    ? `第 ${hoverInfo.row + 1} 行 · ${hoverInfo.col + 1} 列 · ${hoverInfo.label}`
                    : mode === 'guide' && targetPos
                      ? `目标：第 ${targetPos.row + 1} 行 · ${targetPos.col + 1} 列`
                      : `${cols} × ${rows} · ${steps.length} 色`
                )}
              </span>
              <div className="spacer" />
              <button
                type="button"
                className="m-icon-button"
                onClick={() => setFitToken((x) => x + 1)}
                title="适应窗口"
                aria-label="适应窗口"
              >
                <Scan size={19} aria-hidden="true" />
              </button>
              {immersive && (
                <button type="button" className="m-icon-button m-immersive-exit" onClick={() => setImmersive(false)} aria-label="退出专注模式" title="退出专注模式">
                  <Minimize2 size={19} aria-hidden="true" />
                </button>
              )}
            </div>
            {canvasEl}
            {progressEl}
            {immersive && (
              <div className="m-immersive-tools">
                {mode === 'guide' && steps.length > 0 ? (
                  <>
                    <button
                      type="button"
                      className="m-icon-button m-immersive-undo"
                      onClick={undo}
                      disabled={history.length === 0}
                      aria-label="撤销"
                      title="撤销"
                    >
                      <Undo2 size={19} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="btn primary m-immersive-action"
                      onClick={guideUnit === 'cell' ? markCurrent : markRegion}
                      disabled={guideUnit === 'cell' ? targetCell === null : regionIndex < 0}
                      aria-label={guideUnit === 'cell' ? '这一粒拼好了' : '这一块拼好了'}
                    >
                      <Check size={19} aria-hidden="true" /> 完成{guideUnit === 'cell' ? '这粒' : '这块'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn primary m-immersive-action"
                    onClick={() => {
                      setSheet('guide')
                      setSheetExpanded(false)
                      setMode('guide')
                      setRightTab('guide')
                      if (currentStep) setSelected(currentStep.paletteIndex)
                    }}
                  >
                    开始指引
                  </button>
                )}
              </div>
            )}
          </section>

          <MobileDrawer
            sheet={sheet}
            onSheet={pickSheet}
            expanded={sheetExpanded}
            onExpanded={setSheetExpanded}
            guideActive={mode === 'guide' && steps.length > 0}
            guideUnit={guideUnit}
            onStartGuide={() => {
              setSheet('guide')
              setSheetExpanded(false)
              setMode('guide')
              setRightTab('guide')
              if (currentStep) setSelected(currentStep.paletteIndex)
            }}
            stepNo={stepIndex + 1}
            stepCount={steps.length}
            code={curCode}
            hex={curHex}
            regionIndex={regionIndex}
            regionCount={colorRegions.length}
            regionPending={currentRegionPending.length}
            canMark={guideUnit === 'cell' ? targetCell !== null : regionIndex >= 0}
            canUndo={history.length > 0}
            onMarkRegion={guideUnit === 'cell' ? markCurrent : markRegion}
            onUndo={undo}
          >
            {sheet === 'guide' && guidePanelEl}
            {sheet === 'colors' && colorListEl}
            {sheet === 'display' && displayEl}
            {sheet === 'info' && infoEl}
          </MobileDrawer>
        </main>
      </div>
    )
  }

  /* ------------------------- 桌面端布局 ------------------------- */

  return (
    <div className="app">
      <header className="topbar">
        <Logo />
        <div className="topbar-name" title={fileName}>
          {fileName}
          <span className="muted small">
            {' '}
            · {pattern.grid.cols}×{pattern.grid.rows} · {plan.colors.length} 色 · {plan.total} 粒
          </span>
        </div>
        <div className="spacer" />

        <div className="mode-switch">
          <button
            type="button"
            className={mode === 'browse' ? 'active' : ''}
            onClick={() => setMode('browse')}
          >
            看颜色分布
          </button>
          <button
            type="button"
            className={mode === 'guide' ? 'active' : ''}
            onClick={() => {
              setMode('guide')
              setRightTab('guide')
              if (currentStep) setSelected(currentStep.paletteIndex)
            }}
          >
            开始拼豆指引
          </button>
        </div>

        <label className="inline-field">
          <span>色号体系</span>
          <select value={brand} onChange={(e) => setBrand(e.target.value as Brand)}>
            {BRANDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="btn" onClick={startOver}>
          换一张
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) loadFile(f)
            e.target.value = ''
          }}
        />
      </header>

      {notice && (
        <div className="notice-bar">
          {notice}
          <button type="button" className="btn tiny" onClick={() => setNotice(null)}>
            知道了
          </button>
        </div>
      )}
      {error && <div className="error-box wide">{error}</div>}

      <main className="workspace">
        <aside className="panel side left">{colorListEl}</aside>

        <section className="stage">
          <div className="stage-bar">
            <span className="muted small">
              {hoverInfo
                ? `第 ${hoverInfo.row + 1} 行 · 第 ${hoverInfo.col + 1} 列 · ${hoverInfo.label}`
                : mode === 'guide' && targetPos
                  ? `目标：第 ${targetPos.row + 1} 行 · 第 ${targetPos.col + 1} 列`
                  : '在图纸上移动鼠标查看每一格的色号'}
            </span>
            <div className="spacer" />
            <label className="checkbox compact">
              <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
              网格
            </label>
            <label className="checkbox compact">
              <input type="checkbox" checked={showCodes} onChange={(e) => setShowCodes(e.target.checked)} />
              色号
            </label>
            <label className="checkbox compact">
              <input
                type="checkbox"
                checked={showSectionLines}
                onChange={(e) => setShowSectionLines(e.target.checked)}
              />
              分区线
            </label>
            <button type="button" className="btn tiny" onClick={() => setFitToken((x) => x + 1)}>
              适应窗口
            </button>
          </div>

          {canvasEl}

          {progressEl}
        </section>

        <aside className="panel side right">
          <div className="tabs">
            <button
              type="button"
              className={rightTab === 'guide' ? 'active' : ''}
              onClick={() => setRightTab('guide')}
            >
              拼豆指引
            </button>
            <button
              type="button"
              className={rightTab === 'display' ? 'active' : ''}
              onClick={() => setRightTab('display')}
            >
              显示
            </button>
            <button
              type="button"
              className={rightTab === 'info' ? 'active' : ''}
              onClick={() => setRightTab('info')}
            >
              图纸
            </button>
          </div>

          {rightTab === 'guide' && guidePanelEl}
          {rightTab === 'display' && displayEl}
          {rightTab === 'info' && infoEl}
        </aside>
      </main>
    </div>
  )
}
