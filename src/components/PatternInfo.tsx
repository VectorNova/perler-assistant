interface Props {
  fileName: string
  cols: number
  rows: number
  cellW: number
  cellH: number
  colorCount: number
  beadTotal: number
  blankCells: number
  remapped: number

  codeText: string
  onCodeText: (v: string) => void
  onApplyCodes: () => void
  allowedCount: number | null
  codeNote: string | null
  onClearCodes: () => void
  allowForeignColors: boolean
  onAllowForeignColors: (v: boolean) => void

  lowCount: number
  lowCursor: number
  onJumpLow: () => void
  showLowConf: boolean
  onShowLowConf: (v: boolean) => void

  onExportPattern: () => void
  onExportCsv: () => void
  onExportPng: () => void
  onExportProgress: () => void
  onRecalibrate: () => void
}

/**
 * 「图纸」面板：识别结果、色板约束、识别质量、导出。
 * 桌面端放在右栏、移动端放在底部抽屉里，两边共用。
 */
export default function PatternInfo({
  fileName,
  cols,
  rows,
  cellW,
  cellH,
  colorCount,
  beadTotal,
  blankCells,
  remapped,
  codeText,
  onCodeText,
  onApplyCodes,
  allowedCount,
  codeNote,
  onClearCodes,
  allowForeignColors,
  onAllowForeignColors,
  lowCount,
  lowCursor,
  onJumpLow,
  showLowConf,
  onShowLowConf,
  onExportPattern,
  onExportCsv,
  onExportPng,
  onExportProgress,
  onRecalibrate,
}: Props) {
  return (
    <div className="settings">
      <h3>识别结果</h3>
      <ul className="kv">
        <li>
          <span>图纸</span>
          <b>{fileName}</b>
        </li>
        <li>
          <span>网格</span>
          <b>
            {cols} × {rows} 格
          </b>
        </li>
        <li>
          <span>格距</span>
          <b>
            {cellW.toFixed(2)} × {cellH.toFixed(2)} px
          </b>
        </li>
        <li>
          <span>颜色 / 豆子</span>
          <b>
            {colorCount} 色 / {beadTotal} 粒
          </b>
        </li>
        <li>
          <span>自动识别为空格</span>
          <b>{blankCells} 格</b>
        </li>
        {remapped > 0 && (
          <li>
            <span>因排除色重映射</span>
            <b>{remapped} 格</b>
          </li>
        )}
      </ul>

      <h3>按图纸图例约束色板</h3>
      {allowedCount === null && colorCount > 50 && (
        <div className="callout">
          现在识别出 <b>{colorCount}</b> 种颜色。拼豆图纸通常只有 20~50 色，
          多出来的一般是逐格采样的噪声（格内色号文字、格线、JPEG 压缩）——
          而且色板里有 34 对颜色彼此 ΔE &lt; 2.5，噪声一抖就会换色号。
          把图纸底部图例的色号粘进下面的框里，能大幅收敛（实测某图纸 116 色 → 32 色）。
        </div>
      )}
      <p className="hint small">
        图纸底部的色号表列出了这张图纸真正用到的颜色。把那些色号粘进来，
        匹配范围就从 291 色收窄到这些颜色，能明显减少「认成相邻色号」。
        （格内文字、格线、JPEG 压缩都会让逐格采样带上噪声。）
      </p>
      <textarea
        className="code-input"
        rows={3}
        placeholder="例如： C13 D16 H12 D1 C29 H9 C5 P12 H2 C20 A6 E15 E16 F20 G15 H6 H7 M4 M7 …（补零写法 C05 / H09 也认）"
        value={codeText}
        onChange={(e) => onCodeText(e.target.value)}
      />
      <div className="btn-row">
        <button type="button" className="btn primary" onClick={onApplyCodes}>
          应用并重新识别
        </button>
        <button type="button" className="btn" onClick={onClearCodes} disabled={codeText.length === 0}>
          清空
        </button>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={allowForeignColors}
          onChange={(e) => onAllowForeignColors(e.target.checked)}
        />
        允许图例之外的颜色
      </label>
      <p className="hint small">
        默认关闭。关闭时，与所有图例色号都差得较远的格子也会归到最接近的那个图例色号 ——
        因为「这张图纸只用图例里列出的颜色」是更可靠的先验。
        打开后会回退到 291 色全色板，代价是<b>可能凭空造出图纸上根本没有的色号</b>
        （实测用户反馈的 P1、R8 就是这么来的），只在确认图例抄漏了色号时才该开。
      </p>
      {allowedCount !== null && (
        <div className="detect-hint">
          当前候选色板：{allowedCount} 色
          {codeNote ? ` · ${codeNote}` : ''}
        </div>
      )}
      {allowedCount === null && codeNote && <div className="detect-hint">{codeNote}</div>}

      <h3>识别质量</h3>
      {lowCount === 0 ? (
        <p className="hint small">
          每一格的采样纯度都很高，没有需要人工核对的格子。
          （从本地进度恢复时无法重新评估纯度，所以这里会显示为 0。）
        </p>
      ) : (
        <>
          <p className="hint small">
            有 <b>{lowCount}</b> 格的主色占比偏低（可能压在网格线上、或有反锯齿/水印）。
            画布上用琥珀色角标标了出来，建议挨个核对一遍。
          </p>
          <div className="btn-row">
            <button type="button" className="btn" onClick={onJumpLow}>
              跳到第 {Math.min(lowCursor + 1, lowCount)} / {lowCount} 个
            </button>
          </div>
        </>
      )}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={showLowConf}
          onChange={(e) => onShowLowConf(e.target.checked)}
        />
        在图纸上标出这些格子
      </label>

      <h3>导出</h3>
      <div className="btn-row wrap">
        <button type="button" className="btn" onClick={onExportPattern}>
          识别结果 PNG
        </button>
        <button type="button" className="btn" onClick={onExportCsv}>
          采购清单 CSV
        </button>
        <button type="button" className="btn" onClick={onExportPng}>
          采购清单图
        </button>
        <button type="button" className="btn" onClick={onExportProgress}>
          导出进度 JSON
        </button>
      </div>

      <h3>说明</h3>
      <p className="hint small">
        识别结果基于每格的主色，再映射到 291 色标准拼豆色板（CIEDE2000 色差）。
        图纸若是纯色填充，通常能精确命中色号。若发现某些格子不对，多半是网格没有完全对齐 ——
        重新上传同一张图纸即可重新校准。
      </p>
      <div className="btn-row">
        <button type="button" className="btn" onClick={onRecalibrate}>
          重新上传并校准
        </button>
      </div>
    </div>
  )
}
