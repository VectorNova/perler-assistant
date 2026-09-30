/** 支持的拼豆色号体系 */
export type Brand = 'MARD' | 'COCO' | '漫漫' | '盼盼' | '咪小窝'

export const BRANDS: Brand[] = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝']

export type RGB = [number, number, number]
export type Lab = [number, number, number]

/** 调色板中的一种豆子 */
export interface PaletteEntry {
  /** 归一化后的 #RRGGBB（大写） */
  hex: string
  rgb: RGB
  lab: Lab
  /** 各品牌下的色号 */
  keys: Record<Brand, string>
}

/**
 * 网格标定结果。网格线位于 offsetX + i*cellW（i = 0..cols）。
 * 也就是说第 (r, c) 格的左上角是 (offsetX + c*cellW, offsetY + r*cellH)。
 */
export interface GridSpec {
  offsetX: number
  offsetY: number
  /** 格子宽度（像素，可为小数） */
  cellW: number
  /** 格子高度（像素，可为小数） */
  cellH: number
  /** 横向格子数 */
  cols: number
  /** 纵向格子数 */
  rows: number
}

/** 空格（不放豆）在内部用 -1 表示 */
export const EMPTY = -1

export interface DetectResult {
  grid: GridSpec
  /** 0..1，越高说明网格线越明显、越可信 */
  confidence: number
  /** 自动识别的网格线坐标，用于叠加显示 */
  lineXs: number[]
  lineYs: number[]
  /** 诊断信息（范围来源、相位、置信度构成），便于排查识别问题 */
  debug?: string
}

/** 从图纸图像识别出来的原始结果（未应用排除色） */
export interface Pattern {
  id: string
  name: string
  imageW: number
  imageH: number
  grid: GridSpec
  /** 长度 rows*cols 的调色板下标，EMPTY 表示该格无法采样 */
  cells: Int16Array
  /**
   * 自动识别出来的「背景空白格」掩码（长度同 cells）。
   * 这些格子的颜色接近页面背景、且与图纸外沿连通。
   * 单独存成掩码而不是直接把 cells 置空，是为了让用户随时把这个
   * 判断关掉 —— 贴边的白色豆子很容易被误判成空白。
   */
  blank: Uint8Array
  /** 每格的采样纯度 0..1，用于提示哪些格子识别不太确定 */
  purity: Float32Array
  /** 自动识别的页面背景色 */
  pageBg: RGB
  /** 原图（用于预览） */
  imageUrl: string
  createdAt: number
}

/** 应用排除色 / 品牌后得到的实际拼装方案 */
export interface Plan {
  /** 生效的格子颜色（排除色已重映射），EMPTY 表示不拼 */
  cells: Int16Array
  /** 调色板下标 -> 豆子数量 */
  counts: Map<number, number>
  /** 用到的调色板下标，按用量降序 */
  colors: number[]
  /** 总豆子数 */
  total: number
  /** 因排除而被重映射的格子数 */
  remapped: number
}

export type ColorOrderMode = 'countDesc' | 'countAsc' | 'firstSeen' | 'code'
/** 色块内部的拼装路径 */
export type CellOrderMode = 'row' | 'snake' | 'nearest'
/**
 * 非选中颜色的处理方式
 * - dim：压暗（默认，保留可辨识的形状）
 * - grayscale：转灰度
 * - hide：完全隐藏
 */
export type DimMode = 'dim' | 'grayscale' | 'hide'

/**
 * 色块之间的优先级。
 * - flow：从左上角那块开始，每步都走「离当前块最近」的下一块（空隙距离），
 *   并带一点点阅读方向偏置；整体自然地从左上流到右下，不会大跳。
 * - rowMajor：严格逐行 —— 先按上边界、再按左边界排，一行一行往下。
 * - nearest：动态选「离上次落点最近」的块（依赖拼到哪里，不是固定序列）。
 * - largest：大块优先（按面积），效率高但会满图跳。
 * - edgeFirst：贴着图纸外沿的块优先。
 */
export type RegionOrderMode = 'flow' | 'rowMajor' | 'nearest' | 'largest' | 'edgeFirst'

export interface OrderOptions {
  colorOrder: ColorOrderMode
  cellOrder: CellOrderMode
  regionOrder: RegionOrderMode
}

/**
 * 一种颜色里的一块 4 连通同色区域 —— 拼豆时的实际工作单元。
 * 和参考项目一致：一片区域整体拼完，而不是一粒一粒点。
 */
export interface Region {
  /** 块内格子，已按 cellOrder 排好拼装路径 */
  cells: number[]
  size: number
  minR: number
  maxR: number
  minC: number
  maxC: number
  /** 块中心（「最近优先」用它算距离） */
  centerR: number
  centerC: number
  /** 是否贴着图纸外沿 */
  touchesEdge: boolean
}

/** 一个颜色的一步（用于指引流程） */
export interface ColorStep {
  paletteIndex: number
  key: string
  hex: string
  count: number
  /** 全部待拼格子（按色块顺序展平），用于「按单粒」模式与兜底 */
  cells: number[]
  /** 4 连通色块，已按 regionOrder 排好优先级 */
  regions: Region[]
}
