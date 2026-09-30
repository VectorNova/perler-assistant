import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectStatus, ProjectSummary } from '../lib/projects'
import Logo from './Logo'

interface Props {
  projects: ProjectSummary[]
  loading: boolean
  busy: boolean
  error: string | null
  onFile: (f: File) => void
  onDemo: (name: string) => void
  onOpen: (id: string) => void
  onRecalibrate: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string, name: string) => void
  onSetStatus: (id: string, status: ProjectStatus) => void
  onCleanupFailed: () => void
}

type Tab = ProjectStatus

const TAB_LABELS: { key: Tab; label: string }[] = [
  { key: 'active', label: '待完成' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '识别失败' },
]

/**
 * 首页的示例图纸。
 *
 * `optional: true` 的那张是作者自己的实拍图纸（第三方同人图），不进公开仓库，
 * 所以刷新时先探一下在不在：不在就不显示这个按钮，避免出现点了报错的坏按钮。
 */
const DEMOS: { key: string; label: string; optional?: boolean }[] = [
  { key: 'a', label: '标准图纸' },
  { key: 'b', label: '细密+噪点' },
  { key: 'c', label: '纯像素图' },
  { key: 'd', label: '带图例' },
  { key: 'e', label: '深色格线' },
  { key: 'user.jpg', label: '104×104 实拍图纸', optional: true },
]

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function ProjectHome({
  projects,
  loading,
  busy,
  error,
  onFile,
  onDemo,
  onOpen,
  onRecalibrate,
  onRename,
  onDelete,
  onSetStatus,
  onCleanupFailed,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [tab, setTab] = useState<Tab>('active')
  const [editing, setEditing] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  /** 可选示例是否存在（键 → 是否 200） */
  const [sampleOk, setSampleOk] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const optional = DEMOS.filter((d) => d.optional)
    if (optional.length === 0) return
    let alive = true
    void Promise.all(
      optional.map(async (d) => {
        try {
          const r = await fetch(`/samples/${d.key}`, { method: 'HEAD' })
          return [d.key, r.ok] as const
        } catch {
          return [d.key, false] as const
        }
      }),
    ).then((pairs) => {
      if (alive) setSampleOk(Object.fromEntries(pairs))
    })
    return () => {
      alive = false
    }
  }, [])

  const demoList = DEMOS.filter((d) => !d.optional || sampleOk[d.key] === true)

  const groups = useMemo(() => {
    const g: Record<Tab, ProjectSummary[]> = { active: [], done: [], failed: [] }
    for (const p of projects) g[p.status].push(p)
    return g
  }, [projects])

  /** 所有待完成项目的累计进度 —— 首页顶部的「当前拼豆总进程」 */
  const overall = useMemo(() => {
    let done = 0
    let total = 0
    for (const p of projects) {
      if (p.status === 'failed') continue
      done += p.doneCount
      total += p.total
    }
    return { done, total, percent: total > 0 ? (done / total) * 100 : 0, count: groups.active.length }
  }, [projects, groups.active.length])

  const list = groups[tab]

  /**
   * 改变项目归类后自动切到目标分类。
   * 否则点「标记完成」后卡片会从当前（待完成）列表里消失，看不出它去哪了。
   */
  const changeStatus = (id: string, status: ProjectStatus) => {
    setConfirmDel(null)
    setTab(status)
    onSetStatus(id, status)
  }

  const startRename = (p: ProjectSummary) => {
    setEditing(p.id)
    // 还是默认名「项目N」时，直接用图纸文件名做初值 —— 一般就是图纸的名字
    const isDefault = /^项目\s*\d+$/.test(p.name.trim())
    const stem = (p.imageName || '').replace(/\.[^.]+$/, '').trim()
    setDraftName(isDefault && stem ? stem : p.name)
  }
  const commitRename = () => {
    if (editing) onRename(editing, draftName.trim())
    setEditing(null)
  }

  return (
    <div className="home">
      <header className="home-top">
        <Logo />
        <div className="spacer" />
        <span className="muted small">
          项目存在本机浏览器里（IndexedDB），不上传任何服务器
        </span>
      </header>

      <div className="home-body">
        <section className="home-hero">
          <h1>
            <img className="logo-mark" src="/logo-96.png" alt="" width={34} height={34} />
            拼豆辅助
          </h1>
          <p className="tagline">
            上传一张<strong>现成的拼豆图纸</strong>，自动识别网格与色号分布，
            再按颜色一块一块指引你拼完。中途停下，下次接着拼。
          </p>

          <div
            className={`dropzone compact ${dragging ? 'dragging' : ''} ${busy ? 'busy' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              const f = e.dataTransfer.files?.[0]
              if (f) onFile(f)
            }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
            }}
          >
            <div className="dropzone-icon">🖼️</div>
            <div className="dropzone-title">
              {busy ? '正在读取图纸…' : '新建项目：点击选择图纸，或拖到这里'}
            </div>
            <div className="muted small">支持 PNG / JPG / WebP。带网格线和色号标注的图纸识别效果最好。</div>
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onFile(f)
                e.target.value = ''
              }}
            />
          </div>

          <div className="demo-row">
            <span className="muted small">没有现成图纸？用示例试一下：</span>
            {demoList.map((d) => (
              <button key={d.key} type="button" className="btn tiny" onClick={() => onDemo(d.key)}>
                {d.label}
              </button>
            ))}
          </div>

          {error && <div className="error-box">{error}</div>}

          {projects.length > 0 && (
            <div className="overall">
              <div className="overall-head">
                <strong>当前总进程</strong>
                <span className="muted small">
                  {overall.count} 个待完成项目 · 累计 {overall.done.toLocaleString()} /{' '}
                  {overall.total.toLocaleString()} 粒
                </span>
                <span className="overall-pct">{overall.percent.toFixed(1)}%</span>
              </div>
              <div className="progress-track big">
                <div className="progress-fill" style={{ width: `${overall.percent}%` }} />
              </div>
            </div>
          )}
        </section>

        <section className="home-projects">
          <div className="tabs home-tabs">
            {TAB_LABELS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`tab ${tab === t.key ? 'on' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
                <span className="tab-count">{groups[t.key].length}</span>
              </button>
            ))}
            <div className="spacer" />
            {tab === 'failed' && list.length > 0 && (
              <button type="button" className="btn tiny danger" onClick={onCleanupFailed}>
                全部删除（{list.length}）
              </button>
            )}
          </div>

          {loading ? (
            <div className="empty-state small">正在读取项目…</div>
          ) : list.length === 0 ? (
            <div className="empty-state small">
              {tab === 'active'
                ? '还没有待完成的项目。上传一张图纸开始吧。'
                : tab === 'done'
                  ? '还没有已完成的项目。拼到 100% 会自动归到这里（也会一直保存）。'
                  : '没有标记为「识别失败」的项目。觉得哪个项目识别得不对，在卡片上点「识别失败」即可归类，方便以后清理。'}
            </div>
          ) : (
            <div className="proj-grid">
              {list.map((p) => (
                <div key={p.id} className={`proj-card ${p.status === 'failed' ? 'is-failed' : ''}`}>
                  <div className="proj-thumb" onClick={() => onOpen(p.id)}>
                    {p.thumb ? (
                      <img src={p.thumb} alt={p.name} />
                    ) : (
                      <span className="proj-thumb-none">无缩略图</span>
                    )}
                    {p.percent >= 100 && <span className="proj-badge done">已完成</span>}
                    {p.status === 'failed' && <span className="proj-badge failed">识别失败</span>}
                  </div>

                  <div className="proj-main">
                    {editing === p.id ? (
                      <div className="proj-rename">
                        <input
                          className="proj-name-input"
                          value={draftName}
                          autoFocus
                          onChange={(e) => setDraftName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename()
                            if (e.key === 'Escape') setEditing(null)
                          }}
                        />
                        <button type="button" className="btn tiny primary" onClick={commitRename}>
                          保存
                        </button>
                        <button type="button" className="btn tiny" onClick={() => setEditing(null)}>
                          取消
                        </button>
                      </div>
                    ) : (
                      <div className="proj-title">
                        <span className="proj-name" title={p.name}>
                          {p.name}
                        </span>
                        <button
                          type="button"
                          className="btn tiny ghost"
                          title="重命名"
                          onClick={() => startRename(p)}
                        >
                          ✎
                        </button>
                      </div>
                    )}

                    <div
                      className="muted small proj-meta"
                      title={
                        `${p.cols} × ${p.rows} 格 · ${p.colorCount} 色 · ${p.total.toLocaleString()} 粒` +
                        (p.blankCount > 0 ? ` · ${p.blankCount} 空格` : '') +
                        (p.confidence > 0 && p.confidence < 0.45 ? ' · 识别置信度偏低' : '')
                      }
                    >
                      {p.cols} × {p.rows} 格 · {p.colorCount} 色 · {p.total.toLocaleString()} 粒
                      {p.blankCount > 0 ? ` · ${p.blankCount} 空格` : ''}
                      {p.confidence > 0 && p.confidence < 0.45 ? ' · ⚠ 识别置信度偏低' : ''}
                    </div>

                    <div className="proj-progress">
                      <div className="progress-track">
                        <div
                          className={`progress-fill ${p.percent >= 100 ? 'complete' : ''}`}
                          style={{ width: `${p.percent}%` }}
                        />
                      </div>
                      <span className="proj-pct">{p.percent.toFixed(1)}%</span>
                    </div>
                    <div className="muted small">
                      已拼 {p.doneCount.toLocaleString()} / {p.total.toLocaleString()} 粒 · 更新于{' '}
                      {fmtTime(p.updatedAt)}
                    </div>
                  </div>

                  <div className="proj-actions">
                    <button type="button" className="btn tiny primary" onClick={() => onOpen(p.id)}>
                      {p.percent > 0 && p.percent < 100 ? '继续拼' : p.percent >= 100 ? '查看' : '开始拼'}
                    </button>
                    <button type="button" className="btn tiny" onClick={() => onRecalibrate(p.id)}>
                      重新校准
                    </button>
                    {p.status !== 'done' && (
                      <button
                        type="button"
                        className="btn tiny"
                        onClick={() => changeStatus(p.id, 'done')}
                        title="手动归类到「已完成」"
                      >
                        标记完成
                      </button>
                    )}
                    {p.status === 'done' && (
                      <button
                        type="button"
                        className="btn tiny"
                        onClick={() => changeStatus(p.id, 'active')}
                        title="移回「待完成」"
                      >
                        取消完成
                      </button>
                    )}
                    {p.status !== 'failed' ? (
                      <button
                        type="button"
                        className="btn tiny"
                        onClick={() => changeStatus(p.id, 'failed')}
                        title="识别得不理想？归类到「识别失败」，方便以后一起清理"
                      >
                        识别失败
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn tiny"
                        onClick={() => changeStatus(p.id, 'active')}
                      >
                        移回待完成
                      </button>
                    )}
                    {confirmDel === p.id ? (
                      <span className="proj-confirm">
                        <button
                          type="button"
                          className="btn tiny danger"
                          onClick={() => {
                            setConfirmDel(null)
                            onDelete(p.id, p.name)
                          }}
                        >
                          确认删除
                        </button>
                        <button type="button" className="btn tiny" onClick={() => setConfirmDel(null)}>
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn tiny danger"
                        onClick={() => setConfirmDel(p.id)}
                      >
                        删除
                      </button>
                    )}
                  </div>

                  {p.imageName && (
                    <div className="proj-file" title={p.imageName}>
                      图纸：{p.imageName}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
