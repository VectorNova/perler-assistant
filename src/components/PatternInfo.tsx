import type { PaletteSystemId, PaletteSystemOption } from '../lib/color'
import type { RecognitionSummary } from '../types'

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
  recognition?: RecognitionSummary

  codeText: string
  onCodeText: (v: string) => void
  onApplyCodes: () => void
  allowedCount: number | null
  codeNote: string | null
  onClearCodes: () => void
  allowForeignColors: boolean
  onAllowForeignColors: (v: boolean) => void
  paletteSystem: PaletteSystemId
  paletteSystems: readonly PaletteSystemOption[]
  onPaletteSystem: (id: PaletteSystemId) => void

  lowCount: number
  /** 按原因分类的待核对格子数（色号歧义 / 纯度低 / 接近背景） */
  lowReasons: { ambiguous: number; lowPurity: number; background: number; text: number; conflict: number }
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
  recognition,
  codeText,
  onCodeText,
  onApplyCodes,
  allowedCount,
  codeNote,
  onClearCodes,
  allowForeignColors,
  onAllowForeignColors,
  paletteSystem,
  paletteSystems,
  onPaletteSystem,
  lowCount,
  lowReasons,
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

      <h3>色号体系</h3>
      <p className="hint small">
        MARD 的色号表分两套：<b>221 色</b>是国内零售最常见的版本（只到 A–H 和 M），
        <b>291 色</b>是它的扩展（多出 P / Q / R / T / Y / ZG 共 70 个色号）。
        选错的话，识别结果里会出现<b>图纸上根本不存在的色号</b> ——
        这正是「原图没有 P1、R8 却识别出来了」的原因。
      </p>
      <div className="seg-row">
        {paletteSystems.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`btn seg${paletteSystem === s.id ? ' active' : ''}`}
            onClick={() => onPaletteSystem(s.id)}
            title={s.hint}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="hint small">
        {paletteSystems.find((s) => s.id === paletteSystem)?.hint}
        {paletteSystem === 'MARD221' && '（默认：零售最常见，也最保守）'}
      </p>

      <h3>按图纸图例约束色板</h3>
      {allowedCount === null && colorCount > 50 && (!recognition || recognition.recognizedCells < cols * rows * 0.5) && (
        <div className="callout">
          当前有 <b>{colorCount}</b> 种颜色，较多格子仍依赖颜色候选。
          若数量与原图图例不同，可将图例色号输入下面的框，约束候选并检查文字冲突。
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
      {recognition && (
        <p className="hint small">
          已根据格内色号确认 <b>{recognition.recognizedCells}</b> 格；
          有字但尚未可靠读出 <b>{recognition.unresolvedCells}</b> 格。
          程序在本机读取原图文字，未确认的格子保留颜色候选，建议对照原图核对。
        </p>
      )}
      {lowCount === 0 ? (
        <p className="hint small">
          当前没有检测到需要核对的格子。这表示现有证据通过检查，不能保证任意图纸都完全正确。
          旧项目可能没有字符识别证据，可重新校准以使用新的识别流程。
        </p>
      ) : (
        <>
          <p className="hint small">
            有 <b>{lowCount}</b> 格建议核对，按可疑程度排序，画布上用琥珀色角标标了出来。
          </p>
          {(lowReasons.ambiguous > 0 || lowReasons.lowPurity > 0 || lowReasons.background > 0 || lowReasons.text > 0) && (
            <ul className="info-list">
              {lowReasons.text > 0 && (
                <li><span>格内色号未能可靠读出</span><b>{lowReasons.text} 格</b></li>
              )}
              {lowReasons.conflict > 0 && (
                <li><span>格内色号与所选体系或图例冲突</span><b>{lowReasons.conflict} 格</b></li>
              )}
              {lowReasons.ambiguous > 0 && (
                <li>
                  <span>色号分不开（第一第二候选几乎一样近）</span>
                  <b>{lowReasons.ambiguous} 格</b>
                </li>
              )}
              {lowReasons.lowPurity > 0 && (
                <li>
                  <span>采样纯度低（可能压在网格线/反锯齿上）</span>
                  <b>{lowReasons.lowPurity} 格</b>
                </li>
              )}
              {lowReasons.background > 0 && (
                <li>
                  <span>颜色接近背景（可能其实是白色豆子）</span>
                  <b>{lowReasons.background} 格</b>
                </li>
              )}
            </ul>
          )}
          <p className="hint small">
            「色号分不开」是<b>颜色本身</b>的问题：图纸上这两种颜色太接近，
            只靠填色分不出谁是谁。真正可靠的依据是格子里印的色号。
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
        优先读取图纸印出的 MARD 色号；文字不清晰或字体未支持时，根据格内主色和所选色板给出候选。
        不同制图软件的填色可能与标准色板不同，纯色填充也可能匹配到相似色号。
        请保留原图清晰度，检查网格与待确认格子；原图有字的白色格不会因接近纸面背景而被删除。
      </p>
      <div className="btn-row">
        <button type="button" className="btn" onClick={onRecalibrate}>
          重新上传并校准
        </button>
      </div>
    </div>
  )
}
