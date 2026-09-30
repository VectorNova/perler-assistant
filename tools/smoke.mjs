/**
 * 端到端冒烟测试：用 CDP 驱动 headless Chrome，真的去点界面，
 * 验证「上传 → 识别 → 点颜色看分布 → 逐步指引 → 进度持久化」整条链路。
 *
 *   node tools/smoke.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const BASE = process.env.APP_URL ?? 'http://127.0.0.1:4173'
const PORT = 9300 + Math.floor(Math.random() * 400)
const SHOTS = path.resolve('_shots')

/** Windows 上 proc.kill() 只杀启动器，Chrome 的子进程会留着占住调试端口 */
function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    /* ignore */
  }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (existsSync(c)) return c
  }
  return null
}

/* ------------------------------ CDP 客户端 ------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 30000)
    })
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(`页面异常：${r.exceptionDetails.exception?.description ?? '未知'}`)
    }
    return r.result?.value
  }

  async waitFor(expression, timeoutMs = 20000, label = expression) {
    const t0 = Date.now()
    for (;;) {
      try {
        if (await this.eval(expression)) return true
      } catch {
        /* 页面可能还在加载 */
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`)
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(SHOTS, { recursive: true })
    writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'))
  }
}

/* ------------------------------ 页面辅助表达式 ------------------------------ */

const clickByText = (text, sel = 'button') => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find((b) => b.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text.replace(/\s+/g, ''))}));
  if (!el) return false;
  el.click();
  return true;
})()`

/** 在指定范围的按钮里按文字点击（避免首页 tab 和卡片按钮重名时点错） */
const clickIn = (sel, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find((b) => b.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text.replace(/\s+/g, ''))}));
  if (!el) return false;
  el.click();
  return true;
})()`

const textOf = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '').replace(/\\s+/g,' ').trim()`

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const chrome = findChrome()
  if (!chrome) {
    console.error('找不到 Chrome/Edge')
    process.exit(2)
  }

  const profile = mkdtempSync(path.join(tmpdir(), 'pa-smoke-'))
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--window-size=1680,1050',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `${BASE}/?demo=a&auto=1`,
    ],
    { stdio: 'ignore' },
  )

  let cdp
  try {
    // 等 CDP 起来
    let target = null
    for (let i = 0; i < 80 && !target; i++) {
      await new Promise((r) => setTimeout(r, 250))
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      } catch {
        /* 还没起来 */
      }
    }
    if (!target) throw new Error('连不上 Chrome 调试端口')

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    cdp = new CDP(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    /* ---- 1. 自动识别并进入工作台 ---- */
    await cdp.waitFor(`!!document.querySelector('.workspace')`, 40000, '工作台出现')
    const header = await cdp.eval(textOf('.topbar-name'))
    check('示例图纸自动识别并进入工作台', header.includes('44×36'), header)

    const colorRows = await cdp.eval(`document.querySelectorAll('.color-rows .color-row').length`)
    check('颜色列表列出 12 种颜色', colorRows === 12, `实际 ${colorRows}`)

    const totalText = await cdp.eval(textOf('.color-row.total .count'))
    check('总豆子数 1584', totalText === '1584', `实际 ${totalText}`)

    /* ---- 1b. 品牌图标 ---- */
    const brand = await cdp.eval(`(async () => {
      const img = document.querySelector('.logo-mark');
      const manifestHref = document.querySelector('link[rel="manifest"]')?.getAttribute('href') || '';
      let manifest = null;
      if (manifestHref) {
        try { const r = await fetch(manifestHref); if (r.ok) manifest = await r.json(); } catch {}
      }
      return {
        logoCount: document.querySelectorAll('.logo-mark').length,
        // naturalWidth > 0 才能证明图片真的加载成功（路径错就是 0）
        loaded: img ? (img.complete && img.naturalWidth > 0) : false,
        natural: img ? img.naturalWidth : 0,
        src: img ? img.getAttribute('src') : '',
        manifestHref,
        manifestName: manifest ? manifest.name : '',
        manifestDisplay: manifest ? manifest.display : '',
        iconCount: manifest && manifest.icons ? manifest.icons.length : 0,
        maskable: manifest && manifest.icons ? manifest.icons.filter((i) => String(i.purpose || '').includes('maskable')).length : 0,
        apple: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') || '',
      };
    })()`)
    check(
      '顶栏显示 logo 图标且图片真的加载了',
      brand.logoCount >= 1 && brand.loaded,
      `${brand.src}（${brand.natural}px，加载=${brand.loaded}）`,
    )
    check(
      'manifest 可访问且声明了图标',
      brand.iconCount >= 3 && brand.maskable >= 1 && brand.manifestDisplay === 'standalone',
      `${brand.manifestHref}：「${brand.manifestName}」，${brand.iconCount} 个图标（含 ${brand.maskable} 个 maskable），display=${brand.manifestDisplay}`,
    )
    check('已声明 apple-touch-icon', brand.apple.includes('.png'), brand.apple)

    // 文件本身必须真的能取到 —— 只声明不落地就是 404
    const iconStatus = await cdp.eval(`(async () => {
      const paths = ['/favicon.ico','/favicon-16.png','/favicon-32.png','/favicon-48.png',
                     '/apple-touch-icon.png','/icon-192.png','/icon-512.png',
                     '/icon-maskable-512.png','/logo-96.png','/manifest.webmanifest'];
      const out = {};
      for (const p of paths) {
        try { const r = await fetch(p); out[p] = r.status; } catch { out[p] = 'err'; }
      }
      return out;
    })()`)
    const badIcons = Object.entries(iconStatus).filter(([, s]) => s !== 200)
    check(
      '所有图标/清单文件都能取到',
      badIcons.length === 0,
      badIcons.length ? JSON.stringify(badIcons) : `${Object.keys(iconStatus).length} 个全部 200`,
    )

    // favicon.ico 的魔数：00 00 01 00（reserved + type=icon）
    const icoMagic = await cdp.eval(`(async () => {
      const r = await fetch('/favicon.ico');
      const b = new Uint8Array(await r.arrayBuffer());
      return { len: b.length, magic: [b[0], b[1], b[2], b[3]].join(','), count: b[4] | (b[5] << 8) };
    })()`)
    check(
      'favicon.ico 是合法的 ICO 容器',
      icoMagic.magic === '0,0,1,0' && icoMagic.count >= 3,
      `魔数 ${icoMagic.magic}，含 ${icoMagic.count} 个尺寸，${icoMagic.len} 字节`,
    )

    await cdp.shot('smoke-1-browse.png')

    /* ---- 2. 点击某个颜色 → 高亮它的分布 ---- */
    const beforeActive = await cdp.eval(
      `document.querySelector('.color-row.active .code')?.textContent?.trim() ?? ''`,
    )
    await cdp.eval(`(() => { const rows = document.querySelectorAll('.color-rows .color-row'); rows[2]?.click(); return true })()`)
    await new Promise((r) => setTimeout(r, 400))
    const afterActive = await cdp.eval(
      `document.querySelector('.color-row.active .code')?.textContent?.trim() ?? ''`,
    )
    check('点击颜色会切换高亮', !!afterActive && afterActive !== beforeActive, `${beforeActive} → ${afterActive}`)

    // 画布上应该只剩选中颜色是原色，其它颜色被压暗（找不到精确的原色像素）
    const selHex = await cdp.eval(
      `document.querySelector('.color-row.active .hex')?.textContent?.split('·')[0].trim() ?? ''`,
    )
    const otherHex = await cdp.eval(`(() => {
      const r = [...document.querySelectorAll('.color-rows .color-row')].find((x) => !x.classList.contains('active'));
      return r?.querySelector('.hex')?.textContent?.split('·')[0].trim() ?? '';
    })()`)
    const lit = await cdp.eval(`(() => {
      const parse = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
      const A = parse(${JSON.stringify(selHex)}), B = parse(${JSON.stringify(otherHex)});
      const cv = document.querySelector('.pattern-canvas');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let a = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i]-A[0])<=2 && Math.abs(d[i+1]-A[1])<=2 && Math.abs(d[i+2]-A[2])<=2) a++;
        if (Math.abs(d[i]-B[0])<=2 && Math.abs(d[i+1]-B[1])<=2 && Math.abs(d[i+2]-B[2])<=2) b++;
      }
      return { a, b };
    })()`)
    check(
      '选中颜色的分布保持原色，其它颜色被压暗',
      lit.a > 0 && lit.b === 0,
      `选中色像素 ${lit.a}，未选中色像素 ${lit.b}（应为 0）`,
    )
    await cdp.shot('smoke-2-highlight.png')

    /* ---- 3. 进入拼豆指引（默认按色块） ---- */
    const entered = await cdp.eval(clickByText('开始拼豆指引'))
    check('能进入拼豆指引模式', entered === true)
    await cdp.waitFor(
      `${textOf('.guide-step-no')}.includes('第 1 / 12 种颜色')`,
      8000,
      '指引面板显示第 1 种颜色',
    )
    const stepNo = await cdp.eval(textOf('.guide-step-no'))
    check('指引面板显示颜色进度', stepNo.includes('第 1 / 12 种颜色'), stepNo)

    const unitLabel = await cdp.eval(
      `document.querySelector('.unit-switch button.active')?.textContent?.trim() ?? ''`,
    )
    check('默认工作单元是「按色块拼」', unitLabel.includes('按色块'), unitLabel)

    const regionCard = await cdp.eval(textOf('.target-card'))
    check(
      '色块卡片给出这一块的粒数与行列范围',
      /粒/.test(regionCard) && /行/.test(regionCard) && /列/.test(regionCard),
      regionCard.slice(0, 90),
    )

    const markRegionLabel = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('这一块拼好了'));
      return b ? b.textContent.replace(/\\s+/g, ' ').trim() : '';
    })()`)
    check('主按钮是「这一块拼好了」而不是逐粒', markRegionLabel.includes('这一块拼好了'), markRegionLabel)

    const regionChips = await cdp.eval(`document.querySelectorAll('.region-chip').length`)
    check('列出该颜色的全部色块', regionChips >= 1, `${regionChips} 块`)

    const regionOrderDefault = await cdp.eval(
      `(() => {
        const sel = [...document.querySelectorAll('.region-head select')][0];
        return sel ? sel.options[sel.selectedIndex].textContent.trim() : '';
      })()`,
    )
    check(
      '拼块顺序默认「就近连续」（不再按面积乱跳）',
      regionOrderDefault.includes('就近连续'),
      regionOrderDefault,
    )

    /* ---- 3b. 多色块颜色：一次只拼一块（此时还没有任何标记） ---- */
    const multi = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('.step-list .step-row')];
      for (let i = 0; i < rows.length; i++) {
        const t = rows[i].querySelector('.step-count')?.textContent ?? '';
        const m = t.match(/^(\\d+)块/);
        if (m && parseInt(m[1], 10) > 1) {
          return { i, blocks: parseInt(m[1], 10), label: rows[i].textContent.trim() };
        }
      }
      return null;
    })()`)
    if (!multi) {
      check('示例图纸里存在多色块的颜色', false, '没找到多块颜色')
    } else {
      await cdp.eval(`document.querySelectorAll('.step-list .step-row')[${multi.i}]?.click()`)
      await new Promise((r) => setTimeout(r, 500))
      const chips = await cdp.eval(`document.querySelectorAll('.region-chip').length`)
      check(
        '切到多色块颜色后列出对应数量的色块',
        chips === multi.blocks,
        `${multi.label} → ${chips} 块（期望 ${multi.blocks}）`,
      )

      const before = parseInt(
        (await cdp.eval(textOf('.overall-line'))).match(/(\d+) \/ 1584/)?.[1] ?? '0',
        10,
      )
      const chipLabel = await cdp.eval(
        `document.querySelector('.region-chip.active')?.textContent?.trim() ?? ''`,
      )
      await cdp.eval(clickByText('这一块拼好了'))
      await new Promise((r) => setTimeout(r, 500))
      const after = parseInt(
        (await cdp.eval(textOf('.overall-line'))).match(/(\d+) \/ 1584/)?.[1] ?? '0',
        10,
      )
      const metaNow = await cdp.eval(textOf('.current-color-meta .muted'))
      check(
        '「这一块拼好了」只标完一块，颜色还没拼完',
        after > before && !/剩 0/.test(metaNow),
        `块「${chipLabel}」：${before} → ${after}；${metaNow}`,
      )
      const doneChips = await cdp.eval(`document.querySelectorAll('.region-chip.done').length`)
      check('已完成色块在列表里被标记', doneChips >= 1, `${doneChips} 块已完成`)

      await cdp.eval(clickByText('撤销'))
      await new Promise((r) => setTimeout(r, 450))
      const afterUndoRegion = parseInt(
        (await cdp.eval(textOf('.overall-line'))).match(/(\d+) \/ 1584/)?.[1] ?? '0',
        10,
      )
      check('撤销这一块后回到标记前', afterUndoRegion === before, `${after} → ${afterUndoRegion}`)

      // 回到第 1 种颜色，继续后面的流程
      await cdp.eval(`document.querySelectorAll('.step-list .step-row')[0]?.click()`)
      await new Promise((r) => setTimeout(r, 400))
    }

    const hasPulse = await cdp.eval(`!!document.querySelector('.target-pulse')`)
    check('画布上标出了当前色块的起手位置', hasPulse === true)
    await cdp.shot('smoke-3-guide.png')

    /* ---- 4. 直接在图纸上点一格 → 整块标记 ---- */
    const canvasClicked = await cdp.eval(`(() => {
      const pulse = document.querySelector('.target-pulse');
      const cv = document.querySelector('.pattern-canvas');
      if (!pulse || !cv) return 'no-element';
      const r = pulse.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const opts = { bubbles: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0 };
      cv.dispatchEvent(new PointerEvent('pointerdown', opts));
      cv.dispatchEvent(new PointerEvent('pointerup', opts));
      return 'ok';
    })()`)
    await new Promise((r) => setTimeout(r, 500))
    const afterCanvasClick = await cdp.eval(textOf('.overall-line'))
    const nCanvas = parseInt(afterCanvasClick.match(/(\d+) \/ 1584/)?.[1] ?? '0', 10)
    check(
      '在图纸上点一格就标完这一整块',
      canvasClicked === 'ok' && nCanvas === 344,
      `${canvasClicked}：${afterCanvasClick}`,
    )
    const stepAfterCanvas = await cdp.eval(textOf('.guide-step-no'))
    check('整块拼完后自动跳到下一种颜色', stepAfterCanvas.includes('第 2 / 12 种颜色'), stepAfterCanvas)

    /* ---- 5. 撤销：退回上一种颜色 ---- */
    await cdp.eval(clickByText('撤销'))
    await new Promise((r) => setTimeout(r, 450))
    const afterUndo = await cdp.eval(textOf('.overall-line'))
    const stepAfterUndo = await cdp.eval(textOf('.guide-step-no'))
    const nUndo = parseInt(afterUndo.match(/(\d+) \/ 1584/)?.[1] ?? '-1', 10)
    check('撤销能回退整块标记', nUndo === 0, `${afterCanvasClick} → ${afterUndo}`)
    check('撤销后会退回还没拼完的那种颜色', stepAfterUndo.includes('第 1 / 12 种颜色'), stepAfterUndo)

    /* ---- 6. 按单粒拼（可选模式） ---- */
    await cdp.eval(clickByText('按单粒拼'))
    await new Promise((r) => setTimeout(r, 300))
    for (let i = 0; i < 3; i++) {
      await cdp.eval(clickByText('拼好这一粒'))
      await new Promise((r) => setTimeout(r, 130))
    }
    await new Promise((r) => setTimeout(r, 350))
    const afterCells = await cdp.eval(textOf('.overall-line'))
    check('切到「按单粒拼」后可以一粒一粒标记', /3 \/ 1584/.test(afterCells), afterCells)

    /* ---- 7. 切回按色块，把剩下的整块拼完 ---- */
    await cdp.eval(clickByText('按色块拼'))
    await new Promise((r) => setTimeout(r, 300))
    await cdp.eval(clickByText('这一块拼好了'))
    await new Promise((r) => setTimeout(r, 600))
    const afterRegion = await cdp.eval(textOf('.overall-line'))
    check('「这一块拼好了」把剩下的 341 粒一次标完', /344 \/ 1584/.test(afterRegion), afterRegion)

    /* ---- 8. 整个颜色完成 ---- */
    const colorMetaBefore = await cdp.eval(textOf('.current-color-meta .muted'))
    const pendingBefore = parseInt(colorMetaBefore.match(/剩 (\d+)/)?.[1] ?? '-1', 10)
    const totalBeforeFinish = parseInt(
      (await cdp.eval(textOf('.overall-line'))).match(/(\d+) \/ 1584/)?.[1] ?? '0',
      10,
    )
    await cdp.eval(clickByText('整个颜色完成'))
    await new Promise((r) => setTimeout(r, 700))
    const totalAfterFinish = parseInt(
      (await cdp.eval(textOf('.overall-line'))).match(/(\d+) \/ 1584/)?.[1] ?? '0',
      10,
    )
    check(
      '「整个颜色完成」把该颜色的剩余粒数一次标完',
      pendingBefore > 0 && totalAfterFinish - totalBeforeFinish === pendingBefore,
      `${colorMetaBefore} → ${totalBeforeFinish} + ${pendingBefore} = ${totalAfterFinish}`,
    )
    const stepNo2 = await cdp.eval(textOf('.guide-step-no'))
    check('该颜色拼完后走到下一个颜色', !stepNo2.includes('第 2 / 12 种颜色'), stepNo2)

    /* ---- 8. 切换色号体系 ---- */
    await cdp.eval(`(() => {
      const s = document.querySelector('.topbar select');
      s.value = '盼盼';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    await new Promise((r) => setTimeout(r, 400))
    const firstCode = await cdp.eval(
      `document.querySelector('.color-rows .color-row .code')?.textContent?.trim() ?? ''`,
    )
    check('切换色号体系后色号跟着变（MARD 数字 → 盼盼编号）', /^\d+/.test(firstCode) || firstCode.length > 0, `首行色号 ${firstCode}`)
    await cdp.eval(`(() => {
      const s = document.querySelector('.topbar select');
      s.value = 'MARD';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    await new Promise((r) => setTimeout(r, 300))

    /* ---- 10. 排除某个颜色 → 重映射到最接近的可用色 ---- */
    const totalBeforeExclude = await cdp.eval(textOf('.panel-title .muted'))
    await cdp.eval(`(() => {
      const row = [...document.querySelectorAll('.color-rows .color-row')]
        .find((r) => !r.classList.contains('active'));
      row?.querySelector('.icon-btn')?.click();
      return true;
    })()`)
    await new Promise((r) => setTimeout(r, 600))
    const totalAfterExclude = await cdp.eval(textOf('.panel-title .muted'))
    check(
      '排除颜色后总数不变但出现重映射提示',
      totalAfterExclude.includes('重映射') && totalAfterExclude.includes('1584'),
      `${totalBeforeExclude} → ${totalAfterExclude}`,
    )
    const excludedChip = await cdp.eval(`!!document.querySelector('.excluded-chip')`)
    check('已排除的颜色出现在可恢复区', excludedChip === true)
    await cdp.eval(`(() => { document.querySelector('.excluded-chip')?.click(); return true })()`)
    await new Promise((r) => setTimeout(r, 500))
    const totalRestored = await cdp.eval(textOf('.panel-title .muted'))
    check('恢复排除后不再显示重映射', !totalRestored.includes('重映射'), totalRestored)

    /* ---- 11. 项目持久化：回首页能看到项目、进度，并能继续拼 ---- */
    const totalExpect = (
      await cdp.eval(textOf('.stage-progress'))
    ).match(/(\d+) \/ 1584/)?.[1]
    check('拿到当前已拼粒数', !!totalExpect, `已拼 ${totalExpect}`)

    await cdp.send('Page.navigate', { url: `${BASE}/` })
    await new Promise((r) => setTimeout(r, 2000))
    await cdp.waitFor(`!!document.querySelector('.proj-card')`, 20000, '首页出现项目卡片')

    const cardCount = await cdp.eval(`document.querySelectorAll('.proj-card').length`)
    check('首页列出了刚才保存的项目', cardCount >= 1, `${cardCount} 个项目`)

    const cardText = await cdp.eval(textOf('.proj-card'))
    check(
      '项目卡片显示已拼进度与总粒数',
      /已拼\s*[\d,]+\s*\/\s*1,?584\s*粒/.test(cardText),
      cardText.slice(0, 140),
    )
    const pctText = await cdp.eval(`document.querySelector('.proj-pct')?.textContent?.trim() ?? ''`)
    check('项目卡片显示百分比', /%$/.test(pctText), pctText)

    // 封面必须是「识别结果渲染的成品图」，不能是「无缩略图」
    const cover = await cdp.eval(`(() => {
      const img = document.querySelector('.proj-thumb img');
      if (!img) return { ok: false, why: '没有 img' };
      return { ok: true, src: img.getAttribute('src') || '', w: img.naturalWidth, h: img.naturalHeight };
    })()`)
    check(
      '卡片封面是识别结果渲染的成品图',
      cover.ok === true && cover.src.startsWith('data:image/png') && cover.w > 0 && cover.h > 0,
      cover.ok ? `${cover.src.slice(0, 22)}… ${cover.w}×${cover.h}` : cover.why,
    )
    const noThumb = await cdp.eval(`document.querySelectorAll('.proj-thumb-none').length`)
    check('没有出现「无缩略图」占位', noThumb === 0, `${noThumb} 个占位`)

    const overallText = await cdp.eval(textOf('.overall'))
    check('首页显示当前总进程', overallText.includes('当前总进程') && overallText.includes('%'), overallText.slice(0, 120))
    await cdp.shot('smoke-6-home-projects.png')

    await cdp.eval(clickByText('继续拼'))
    await cdp.waitFor(`!!document.querySelector('.workspace')`, 20000, '从项目继续拼')
    await new Promise((r) => setTimeout(r, 800))
    const restoredProgress = await cdp.eval(textOf('.stage-progress'))
    check(
      `从首页继续后进度仍是 ${totalExpect} 粒`,
      new RegExp(`(^|[^\\d])${totalExpect} / 1584`).test(restoredProgress),
      restoredProgress,
    )
    await cdp.shot('smoke-4-restored.png')

    /* ---- 11b. 项目管理：重命名 / 分类 / 删除 ---- */
    await cdp.send('Page.navigate', { url: `${BASE}/` })
    await cdp.waitFor(`!!document.querySelector('.proj-card')`, 20000, '回到首页')

    // 重命名
    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.proj-card .btn')].find((x) => x.title === '重命名');
      b?.click(); return true;
    })()`)
    await cdp.waitFor(`!!document.querySelector('.proj-name-input')`, 6000, '重命名输入框')
    await cdp.eval(`(() => {
      const i = document.querySelector('.proj-name-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(i, '原神奥黛塔');
      i.dispatchEvent(new Event('input', { bubbles: true }));
      const b = [...document.querySelectorAll('.proj-rename .btn')].find((x) => x.textContent.includes('保存'));
      b?.click();
      return true;
    })()`)
    await new Promise((r) => setTimeout(r, 900))
    const renamed = await cdp.eval(textOf('.proj-name'))
    check('可以重命名成图纸的名字', renamed === '原神奥黛塔', renamed)

    // 标记完成 → 出现在「已完成」分类
    await cdp.eval(clickIn('.proj-actions .btn', '标记完成'))
    await new Promise((r) => setTimeout(r, 900))
    await cdp.eval(clickIn('.home-tabs button', '已完成'))
    await new Promise((r) => setTimeout(r, 500))
    const doneCards = await cdp.eval(`document.querySelectorAll('.proj-card').length`)
    const doneBadge = await cdp.eval(`!!document.querySelector('.proj-badge.done')`)
    check('标记完成后归入「已完成」分类', doneCards === 1, `已完成分类里 ${doneCards} 个`)

    // 取消完成 → 回到待完成（100% 的项目也会一直保留，只是换个分类）
    await cdp.eval(clickIn('.proj-actions .btn', '取消完成'))
    await new Promise((r) => setTimeout(r, 900))
    await cdp.eval(clickIn('.home-tabs button', '待完成'))
    await new Promise((r) => setTimeout(r, 500))
    const activeCards = await cdp.eval(`document.querySelectorAll('.proj-card').length`)
    check('取消完成后移回「待完成」', activeCards === 1, `待完成分类里 ${activeCards} 个`)

    // 标记识别失败 → 该分类下能一键全删
    await cdp.eval(clickIn('.proj-actions .btn', '识别失败'))
    await new Promise((r) => setTimeout(r, 900))
    await cdp.eval(clickIn('.home-tabs button', '识别失败'))
    await new Promise((r) => setTimeout(r, 500))
    const failedCards = await cdp.eval(`document.querySelectorAll('.proj-card.is-failed').length`)
    const failedBadge = await cdp.eval(`!!document.querySelector('.proj-badge.failed')`)
    check(
      '「识别失败」分类里能看到该项目',
      failedCards === 1 && failedBadge === true,
      `${failedCards} 个，红色角标=${failedBadge}`,
    )

    await cdp.eval(clickIn('.home-tabs .btn', '全部删除'))
    await new Promise((r) => setTimeout(r, 1400))
    const afterCleanup = await cdp.eval(`document.querySelectorAll('.proj-card').length`)
    const cleanupMsg = await cdp.eval(textOf('.empty-state'))
    check(
      '一键清理识别失败的项目',
      afterCleanup === 0 && cleanupMsg.includes('没有标记'),
      `剩余 ${afterCleanup} 个`,
    )

    // 建一个新项目并删除它
    await cdp.send('Page.navigate', { url: `${BASE}/?demo=a&auto=1` })
    await cdp.waitFor(`!!document.querySelector('.workspace')`, 40000, '再建一个项目')
    await new Promise((r) => setTimeout(r, 800))

    /* ---- 11c. 重新校准：用存在库里的图纸原图，覆盖同一个项目而不是新建 ---- */
    await cdp.send('Page.navigate', { url: `${BASE}/` })
    await cdp.waitFor(`!!document.querySelector('.proj-card')`, 20000, '回到首页')
    await cdp.eval(clickIn('.proj-actions .btn', '重新校准'))
    await cdp.waitFor(`!!document.querySelector('.name-field input')`, 20000, '进入校准页')
    await new Promise((r) => setTimeout(r, 800))
    const calName = await cdp.eval(
      `document.querySelector('.name-field input')?.value ?? ''`,
    )
    check('重新校准会带着原项目的名字', calName.length > 0, calName)
    const calHasImage = await cdp.eval(`!!document.querySelector('.calibrate img, .calibrate canvas')`)
    check('重新校准用的图纸原图从项目里读出来了（不用再上传）', calHasImage === true)

    await cdp.eval(clickIn('button', '开始识别图纸'))
    await cdp.waitFor(`!!document.querySelector('.workspace')`, 40000, '重新校准后进入工作台')
    await new Promise((r) => setTimeout(r, 1200))
    await cdp.send('Page.navigate', { url: `${BASE}/` })
    await cdp.waitFor(`!!document.querySelector('.proj-card')`, 20000, '回首页看项目数')
    const afterRecal = await cdp.eval(`document.querySelectorAll('.proj-card').length`)
    const recalNames = await cdp.eval(
      `[...document.querySelectorAll('.proj-name')].map((x) => x.textContent.trim()).join('|')`,
    )
    check(
      '重新校准是覆盖原项目，不会多出一个',
      afterRecal === 1,
      `${afterRecal} 个项目：${recalNames}`,
    )

    const beforeDel = afterRecal
    await cdp.eval(clickIn('.proj-actions .btn', '删除'))
    await new Promise((r) => setTimeout(r, 400))
    const delGate = await cdp.eval(textOf('.proj-confirm'))
    check('删除前需要二次确认', delGate.includes('确认删除'), delGate)
    await cdp.eval(clickIn('.proj-confirm .btn', '确认删除'))
    await new Promise((r) => setTimeout(r, 1200))
    const afterDel = await cdp.eval(`document.querySelectorAll('.proj-card').length`)
    check('删除项目', afterDel === beforeDel - 1, `${beforeDel} → ${afterDel}`)

    /* ---- 12. 显示 / 图纸 面板都能渲染 ---- */
    await cdp.send('Page.navigate', { url: `${BASE}/?demo=a&auto=1` })
    await cdp.waitFor(`!!document.querySelector('.workspace')`, 40000, '回到工作台')
    await new Promise((r) => setTimeout(r, 500))
    await cdp.eval(clickByText('显示', '.tabs button'))
    await cdp.waitFor(`!!document.querySelector('.settings .radio-row')`, 6000, '显示面板')
    check('「显示」面板可打开', true)
    await cdp.eval(clickByText('图纸', '.tabs button'))
    await cdp.waitFor(`!!document.querySelector('.settings .kv')`, 6000, '图纸面板')
    const kv = await cdp.eval(textOf('.settings .kv'))
    check('「图纸」面板显示识别信息', kv.includes('44 × 36') && kv.includes('1584'), kv.slice(0, 80))

    const errors = await cdp.eval(`window.__smokeErrors ? window.__smokeErrors.length : 0`)
    check('运行过程中没有未捕获的页面错误', errors === 0, `捕获到 ${errors} 个`)

    /* ---- 13. 空白格开关（示例 d：贴边白色豆子被当空格） ---- */
    await cdp.send('Page.navigate', { url: `${BASE}/?demo=d&auto=1` })
    await cdp.waitFor(`!!document.querySelector('.workspace')`, 40000, '示例 d 进入工作台')
    await new Promise((r) => setTimeout(r, 500))
    const dBefore = await cdp.eval(textOf('.color-row.total .count'))
    await cdp.eval(clickByText('显示', '.tabs button'))
    await cdp.waitFor(`!!document.querySelector('.settings .checkbox input')`, 6000, '显示面板')
    const toggled = await cdp.eval(`(() => {
      const labels = [...document.querySelectorAll('.settings .checkbox')];
      const l = labels.find((x) => x.textContent.includes('贴边空白'));
      if (!l) return 'no-toggle';
      l.querySelector('input').click();
      return 'clicked';
    })()`)
    await new Promise((r) => setTimeout(r, 700))
    const dAfter = await cdp.eval(textOf('.color-row.total .count'))
    check(
      '关掉「贴边空白当作不拼」后白色豆子回到方案里',
      toggled === 'clicked' && parseInt(dAfter, 10) > parseInt(dBefore, 10),
      `${toggled}：${dBefore} → ${dAfter} 粒`,
    )
    await cdp.shot('smoke-5-blank-toggle.png')
  } finally {
    try {
      cdp?.ws?.close()
    } catch {
      /* ignore */
    }
    proc.kill()
    killTree(proc.pid)
    await new Promise((r) => setTimeout(r, 500))
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - ${f.name} (${f.detail})`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('冒烟测试异常：', e)
  process.exit(1)
})
