/**
 * 手机端布局端到端测试。
 *
 *   node tools/mobile.mjs
 *
 * 用 CDP 的 setDeviceMetricsOverride 强制成手机视口（而不是只缩窗口），
 * 这样才能真实触发 matchMedia('(max-width: 940px)')。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
const BASE = process.env.APP_URL ?? 'http://127.0.0.1:4173'
const PORT = 9800 + Math.floor(Math.random() * 90)
const SHOTS = path.resolve('_shots')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  return !!ok
}

function killTree(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error(JSON.stringify(m.error)))
        else resolve(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 180000)
      timeout.unref?.()
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面异常')
    return r.result?.value
  }
  async waitFor(expr, timeoutMs = 60000, label = expr) {
    const t0 = Date.now()
    for (;;) {
      try {
        if (await this.eval(expr)) return true
      } catch {
        /* 加载中 */
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`)
      await new Promise((r) => setTimeout(r, 120))
    }
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(SHOTS, { recursive: true })
    writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'))
    console.log(`  → _shots/${name}`)
  }
  async click(selector) {
    const point = await this.eval(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`)
    if (!point) throw new Error(`控件不可点击：${selector}`)
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  async escape() {
    const params = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  async tab(shift = false) {
    const params = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
}

const textOf = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '').replace(/\\s+/g,' ').trim()`
const clickIn = (sel, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find((b) => b.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text.replace(/\s+/g, ''))}));
  if (!el) return false;
  el.click();
  return true;
})()`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ERROR_HOOK = `window.__mErrors = []; window.addEventListener('error', (e) => window.__mErrors.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__mErrors.push(String(e.reason)));`
const LAYOUT = `(() => {
  const rect = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return { top: 0, bottom: 0, width: 0, height: 0 };
    const { top, bottom, width, height } = element.getBoundingClientRect();
    return { top, bottom, width, height };
  };
  return {
    stage: rect('.stage'), canvas: rect('.canvas-wrap'), drawer: rect('.m-drawer'),
    compact: rect('.m-compact'), bar: rect('.m-topbar'),
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth, vh: innerHeight,
  };
})()`

function checkCanvasClear(layout, name) {
  check(
    name,
    layout.canvas.height > 0 && layout.stage.bottom <= layout.drawer.top + 1,
    `画布 ${Math.round(layout.canvas.height)}px，工作区底 ${Math.round(layout.stage.bottom)} / 抽屉顶 ${Math.round(layout.drawer.top)}`,
  )
}

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome')
    process.exit(2)
  }
  const profile = mkdtempSync(path.join(tmpdir(), 'pa-mobile-'))
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--hide-scrollbars',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `${BASE}/?demo=a&auto=1`,
    ],
    { stdio: 'ignore' },
  )
  let cdp
  try {
    let target = null
    for (let i = 0; i < 120 && !target; i++) {
      await sleep(250)
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      } catch {
        /* 还没起来 */
      }
    }
    if (!target) throw new Error('连不上调试端口')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    cdp = new CDP(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    // 每次导航都安装错误钩子，覆盖项目创建与首页恢复。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: ERROR_HOOK })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    })
    await cdp.send('Page.navigate', { url: `${BASE}/?demo=a&auto=1` })
    await cdp.waitFor(`!!document.querySelector('.app.mobile')`, 60000, '移动端外壳')
    await sleep(1200)

    /* ---- 1. 用的是移动端外壳，不是桌面三栏 ---- */
    const shell = await cdp.eval(`(() => ({
      mobile: !!document.querySelector('.app.mobile'),
      desktopWorkspace: !!document.querySelector('.workspace'),
      drawer: !!document.querySelector('.m-drawer'),
      w: innerWidth, h: innerHeight,
    }))()`)
    check(
      '手机视口下渲染移动端外壳（不是桌面三栏）',
      shell.mobile && !shell.desktopWorkspace && shell.drawer,
      `视口 ${shell.w}×${shell.h}`,
    )

    /* ---- 2. 没有横向溢出 ---- */
    const overflow = await cdp.eval(`(() => {
      const de = document.documentElement;
      return { scrollW: de.scrollWidth, clientW: de.clientWidth, docH: de.scrollHeight, vh: innerHeight };
    })()`)
    check(
      '没有横向溢出',
      overflow.scrollW <= overflow.clientW + 1,
      `scrollW ${overflow.scrollW} vs clientW ${overflow.clientW}`,
    )

    /* ---- 3. 收起态：画布留出大部分屏幕 ---- */
    const layout = await cdp.eval(LAYOUT)
    check(
      '收起态图纸画布占屏幕主体（≥70% 视口高）',
      layout.canvas.height >= overflow.vh * 0.7,
      `画布 ${Math.round(layout.canvas.height)} / 视口 ${overflow.vh}（顶栏 ${Math.round(layout.bar.height)}，抽屉 ${Math.round(layout.drawer.height)}）`,
    )
    checkCanvasClear(layout, '收起抽屉不遮住图纸底部')
    const canvasColors = await cdp.eval(`(() => {
      const canvas = document.querySelector('.pattern-canvas');
      if (!canvas) return 0;
      const ctx = canvas.getContext('2d');
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set();
      for (let y = 0; y < canvas.height; y += 13) {
        for (let x = 0; x < canvas.width; x += 13) {
          const i = (y * canvas.width + x) * 4;
          colors.add(pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2]);
        }
      }
      return colors.size;
    })()`)
    check('图纸画布渲染了实际色块', canvasColors > 8, `${canvasColors} 种采样颜色`)
    const initialFit = await cdp.eval(`(() => {
      const canvas = document.querySelector('.pattern-canvas');
      const rect = canvas.getBoundingClientRect();
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const background = Array.from(pixels.slice(0, 3));
      const foreground = (x, y) => {
        const p = (y * canvas.width + x) * 4;
        return Math.abs(pixels[p] - background[0]) + Math.abs(pixels[p + 1] - background[1]) + Math.abs(pixels[p + 2] - background[2]) > 40;
      };
      const horizontal = [], vertical = [];
      const midX = Math.floor(canvas.width / 2), midY = Math.floor(canvas.height / 2);
      for (let x = 0; x < canvas.width; x++) if (foreground(x, midY)) horizontal.push(x);
      for (let y = 0; y < canvas.height; y++) if (foreground(midX, y)) vertical.push(y);
      if (!horizontal.length || !vertical.length) return null;
      const sx = rect.width / canvas.width, sy = rect.height / canvas.height;
      const x0 = horizontal[0] * sx, x1 = horizontal[horizontal.length - 1] * sx;
      const y0 = vertical[0] * sy, y1 = vertical[vertical.length - 1] * sy;
      return { x0, x1, y0, y1, width: rect.width, height: rect.height,
        dx: Math.abs((x0 + x1) / 2 - rect.width / 2),
        dy: Math.abs((y0 + y1) / 2 - rect.height / 2) };
    })()`)
    check('首次适应将图纸完整居中在真实画布内',
      initialFit && initialFit.dx <= 12 && initialFit.dy <= 12 &&
      initialFit.x0 >= 8 && initialFit.y0 >= 8 &&
      initialFit.x1 <= initialFit.width - 8 && initialFit.y1 <= initialFit.height - 8,
      initialFit ? `中心误差 ${initialFit.dx.toFixed(1)} / ${initialFit.dy.toFixed(1)}px，边界 ${initialFit.x0.toFixed(0)},${initialFit.y0.toFixed(0)}–${initialFit.x1.toFixed(0)},${initialFit.y1.toFixed(0)}` : '没有检测到图纸边界')

    /* ---- 4. 收起态就能看到关键信息和大按钮 ---- */
    const compact = await cdp.eval(textOf('.m-compact'))
    check(
      '收起态直接给出「开始拼豆指引」',
      compact.includes('开始拼豆指引'),
      compact.slice(0, 60),
    )
    await cdp.shot('mobile-1-browse.png')

    /* ---- 5. 进入指引：紧凑条给出色号 / 块粒数 / 大按钮 ---- */
    await cdp.click('.m-compact-start')
    await sleep(800)
    const compactGuide = await cdp.eval(textOf('.m-compact'))
    check(
      '进入指引后紧凑条显示当前色号与块内粒数',
      /第 \d+\/\d+ 色/.test(compactGuide) && /块 \d+\/\d+/.test(compactGuide) && /\d+ 粒待拼/.test(compactGuide),
      compactGuide.slice(0, 90),
    )
    const markBtn = await cdp.eval(`(() => {
      const b = document.querySelector('.m-compact-complete');
      return b ? { text: b.textContent.trim(), label: b.getAttribute('aria-label'), enabled: !b.disabled } : null;
    })()`)
    check('紧凑条的完成按钮可用且有明确名称', markBtn?.enabled && markBtn.label === '这一块拼好了', markBtn?.text ?? '没有按钮')
    const bigBtnH = await cdp.eval(`(() => {
      const b = document.querySelector('.m-compact-complete');
      return b ? Math.round(b.getBoundingClientRect().height) : 0;
    })()`)
    check('大按钮的触摸高度 ≥ 48px', bigBtnH >= 48, `${bigBtnH}px`)
    await cdp.shot('mobile-2-guide.png')

    /* ---- 6. 点大按钮真的能拼（交互闭环） ---- */
    const before = await cdp.eval(`document.querySelector('.m-topbar-pct')?.textContent?.trim() ?? ''`)
    await cdp.click('.m-compact-complete')
    await sleep(900)
    const after = await cdp.eval(`document.querySelector('.m-topbar-pct')?.textContent?.trim() ?? ''`)
    check('点大按钮真的标记了这一块', before !== after, `${before} → ${after}`)

    /* ---- 专注模式保留完成闭环，同时把画布扩展到视口主体 ---- */
    await cdp.click('.m-focus-toggle')
    await cdp.waitFor(`!!document.querySelector('.app.is-immersive')`, 5000, '进入专注模式')
    await sleep(300)
    const focusLayout = await cdp.eval(LAYOUT)
    check('专注模式图纸画布占视口超过 90%', focusLayout.canvas.height > focusLayout.vh * 0.9,
      `画布 ${Math.round(focusLayout.canvas.height)} / 视口 ${focusLayout.vh}`)
    const focusControls = await cdp.eval(`(() => ({
      topbarHidden: getComputedStyle(document.querySelector('.m-topbar')).display === 'none',
      drawerHidden: getComputedStyle(document.querySelector('.m-drawer')).display === 'none',
      exit: !!document.querySelector('.m-immersive-exit'),
      action: !!document.querySelector('.m-immersive-action:not(:disabled)'),
    }))()`)
    check('专注模式隐藏顶栏和抽屉并保留退出与完成按钮',
      focusControls.topbarHidden && focusControls.drawerHidden && focusControls.exit && focusControls.action)
    const focusBefore = await cdp.eval(textOf('.m-topbar-pct'))
    await cdp.click('.m-immersive-action')
    await cdp.waitFor(`${textOf('.m-topbar-pct')} !== ${JSON.stringify(focusBefore)}`, 5000, '专注模式完成进度更新')
    const focusAfter = await cdp.eval(textOf('.m-topbar-pct'))
    check('专注模式完成按钮更新拼豆进度', focusBefore !== focusAfter, `${focusBefore} → ${focusAfter}`)
    const undoButton = await cdp.eval(`(() => {
      const b = document.querySelector('.m-immersive-undo')
      return b ? { disabled: b.disabled, label: b.getAttribute('aria-label') } : null
    })()`)
    check('专注模式提供可用的撤销按钮', undoButton?.disabled === false && undoButton.label === '撤销')
    await cdp.click('.m-immersive-undo')
    await cdp.waitFor(`${textOf('.m-topbar-pct')} !== ${JSON.stringify(focusAfter)}`, 5000, '专注模式撤销进度更新')
    const focusUndone = await cdp.eval(textOf('.m-topbar-pct'))
    check('专注模式撤销按钮恢复上一进度', focusUndone === focusBefore, `${focusAfter} → ${focusUndone}`)
    await cdp.shot('mobile-focus.png')
    await cdp.click('.m-immersive-exit')
    await cdp.waitFor(`!document.querySelector('.app.is-immersive')`, 5000, '按钮退出专注模式')
    check('退出按钮恢复普通界面', !(await cdp.eval(`!!document.querySelector('.app.is-immersive')`)))
    checkCanvasClear(await cdp.eval(LAYOUT), '退出专注模式后抽屉不遮住图纸')
    await cdp.click('.m-focus-toggle')
    await cdp.waitFor(`!!document.querySelector('.app.is-immersive')`, 5000, '再次进入专注模式')
    await cdp.escape()
    await cdp.waitFor(`!document.querySelector('.app.is-immersive')`, 5000, 'Escape 退出专注模式')
    check('Escape 键退出专注模式', !(await cdp.eval(`!!document.querySelector('.app.is-immersive')`)))

    /* ---- 7. 切「颜色」标签：自动展开并显示颜色列表 ---- */
    await cdp.click('#mobile-tab-colors')
    await sleep(600)
    const colorsState = await cdp.eval(`(() => ({
      expanded: !!document.querySelector('.m-drawer.expanded'),
      rows: document.querySelectorAll('.m-drawer-body .color-rows .color-row').length,
      compactGone: !document.querySelector('.m-compact'),
    }))()`)
    check(
      '点「颜色」标签自动展开并显示颜色列表',
      colorsState.expanded && colorsState.rows > 0 && colorsState.compactGone,
      `${colorsState.rows} 行，展开=${colorsState.expanded}`,
    )
    await cdp.shot('mobile-3-colors.png')

    /* ---- 8. 切「显示」标签：网格/色号开关在这里 ---- */
    await cdp.click('#mobile-tab-display')
    await sleep(600)
    const displayOk = await cdp.eval(
      `!!document.querySelector('.m-drawer-body .settings .radio-row')`,
    )
    check('「显示」抽屉里有显示设置（手机端从画布条移到了这里）', displayOk === true)
    const displayLabels = await cdp.eval(`Array.from(document.querySelectorAll('.settings-display-grid label')).map((e) => e.textContent.trim())`)
    check('显示面板包含网格、色号和分区线开关',
      displayLabels.length === 3 && ['网格', '色号', '分区线'].every((label) => displayLabels.includes(label)), displayLabels.join(' / '))
    for (let i = 0; i < 3; i++) {
      const selector = `.settings-display-grid label:nth-child(${i + 1}) input`
      const initial = await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).checked`)
      await cdp.click(selector)
      await cdp.waitFor(`document.querySelector(${JSON.stringify(selector)}).checked === ${!initial}`, 5000, `${displayLabels[i]}开关切换`)
      const changed = await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).checked`)
      check(`${displayLabels[i]}开关切换 checked 状态`, changed !== initial, `${initial} → ${changed}`)
      await cdp.click(selector)
      await cdp.waitFor(`document.querySelector(${JSON.stringify(selector)}).checked === ${initial}`, 5000, `${displayLabels[i]}开关恢复`)
      check(`${displayLabels[i]}开关可以恢复`, (await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).checked`)) === initial)
    }

    /* ---- 9. 切回「指引」：收起回紧凑条 ---- */
    await cdp.click('#mobile-tab-guide')
    await sleep(500)
    const backToGuide = await cdp.eval(`(() => ({
      compact: !!document.querySelector('.m-compact'),
      expanded: !!document.querySelector('.m-drawer.expanded'),
    }))()`)
    check(
      '切回「指引」自动收起到紧凑条',
      backToGuide.compact && !backToGuide.expanded,
      `compact=${backToGuide.compact} expanded=${backToGuide.expanded}`,
    )

    /* ---- 10. 手动展开：出现完整指引面板，且能滚 ---- */
    await cdp.click('.m-drawer-toggle')
    await sleep(600)
    const expandedState = await cdp.eval(`(() => {
      const b = document.querySelector('.m-drawer-body');
      return {
        expanded: !!document.querySelector('.m-drawer.expanded'),
        guide: !!document.querySelector('.m-drawer-body .guide-step-no'),
        scrollable: b ? b.scrollHeight >= b.clientHeight : false,
        h: b ? Math.round(b.getBoundingClientRect().height) : 0,
      };
    })()`)
    check(
      '展开后出现完整指引面板',
      expandedState.expanded && expandedState.guide && expandedState.scrollable && expandedState.h > 200,
      `面板高 ${expandedState.h}px`,
    )
    const dialogFocus = await cdp.eval(`(() => {
      const dialog = document.querySelector('.m-drawer[role="dialog"]')
      const active = document.activeElement
      return {
        dialog: !!dialog,
        modal: dialog?.getAttribute('aria-modal') === 'true',
        focusedInside: !!dialog && dialog.contains(active),
        focusedSelector: active?.className ?? active?.tagName ?? '',
      }
    })()`)
    check('展开抽屉声明 dialog 并把焦点送入面板',
      dialogFocus.dialog && dialogFocus.modal && dialogFocus.focusedInside,
      `${dialogFocus.focusedSelector}`)
    const focusTrap = await cdp.eval(`(() => {
      const dialog = document.querySelector('.m-drawer[role="dialog"]')
      const controls = [...(dialog?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? [])]
        .filter((element) => element.getClientRects().length > 0)
      controls[controls.length - 1]?.focus()
      return { first: controls[0]?.className ?? '', last: controls.at(-1)?.className ?? '', count: controls.length }
    })()`)
    await cdp.tab()
    const wrappedForward = await cdp.eval(`(() => {
      const dialog = document.querySelector('.m-drawer[role="dialog"]')
      const controls = [...(dialog?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? [])]
        .filter((element) => element.getClientRects().length > 0)
      return controls.length > 0 && document.activeElement === controls[0]
    })()`)
    check('Tab 在抽屉末尾循环回第一个控件', wrappedForward, `${focusTrap.last} → ${focusTrap.first}`)
    await cdp.eval(`(() => {
      const dialog = document.querySelector('.m-drawer[role="dialog"]')
      const controls = [...(dialog?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? [])]
        .filter((element) => element.getClientRects().length > 0)
      controls[0]?.focus()
    })()`)
    await cdp.tab(true)
    const wrappedBackward = await cdp.eval(`(() => {
      const dialog = document.querySelector('.m-drawer[role="dialog"]')
      const controls = [...(dialog?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? [])]
        .filter((element) => element.getClientRects().length > 0)
      return controls.length > 0 && document.activeElement === controls.at(-1)
    })()`)
    check('Shift+Tab 在抽屉开头循环回最后一个控件', wrappedBackward, `${focusTrap.first} → ${focusTrap.last}`)
    await cdp.click('.m-drawer-toggle')
    await cdp.waitFor(`!document.querySelector('.m-drawer.expanded')`, 5000, '焦点测试关闭抽屉')
    const restoredFocus = await cdp.eval(`document.activeElement?.classList?.contains('m-drawer-toggle') && document.activeElement?.getAttribute('aria-expanded') === 'false'`)
    check('关闭抽屉后焦点恢复到展开按钮', restoredFocus)
    await cdp.click('.m-drawer-toggle')
    await cdp.waitFor(`!!document.querySelector('.m-drawer.expanded')`, 5000, '重新打开抽屉')
    await cdp.shot('mobile-4-guide-expanded.png')

    /* ---- 11. 展开时画布仍然可见（不是被完全盖住） ---- */
    const canvasStillVisible = await cdp.eval(`(() => {
      const s = document.querySelector('.stage');
      const d = document.querySelector('.m-drawer');
      if (!s || !d) return 0;
      const sr = s.getBoundingClientRect(), dr = d.getBoundingClientRect();
      return Math.round(Math.max(0, Math.min(sr.bottom, dr.top) - sr.top));
    })()`)
    check(
      '抽屉全展开时画布仍露出可操作区域',
      canvasStillVisible >= 80,
      `画布可见 ${canvasStillVisible}px`,
    )
    const backdrop = await cdp.eval(`(() => {
      const element = document.querySelector('.m-drawer-backdrop');
      const drawer = document.querySelector('.m-drawer');
      if (!element || !drawer) return null;
      const rect = element.getBoundingClientRect();
      return { label: element.getAttribute('aria-label'),
        x: innerWidth / 2, y: Math.max(1, drawer.getBoundingClientRect().top / 2),
        full: rect.width >= innerWidth && rect.height >= innerHeight };
    })()`)
    check('展开抽屉提供有名称的全屏遮罩', backdrop?.full && backdrop.label === '关闭控制面板')
    if (backdrop) {
      const point = { x: backdrop.x, y: backdrop.y }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
      await cdp.waitFor(`!document.querySelector('.m-drawer.expanded')`, 5000, '遮罩关闭抽屉')
      check('点击画布上方遮罩关闭控制面板', !(await cdp.eval(`!!document.querySelector('.m-drawer-backdrop')`)))
      checkCanvasClear(await cdp.eval(LAYOUT), '遮罩关闭抽屉后图纸底部无遮挡')
    }

    /* ---- 手机窄屏与平板使用同一操作外壳且不溢出 ---- */
    for (const width of [320, 360, 390, 900]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: width === 900 ? 1000 : 844, deviceScaleFactor: 2, mobile: true,
      })
      await sleep(350)
      const responsive = await cdp.eval(LAYOUT)
      check(`${width}px 工作界面没有横向溢出`, responsive.scrollW <= responsive.clientW + 1,
        `scrollW ${responsive.scrollW} / clientW ${responsive.clientW}`)
      check(`${width}px 使用移动端外壳`, await cdp.eval(`!!document.querySelector('.app.mobile')`))
      checkCanvasClear(responsive, `${width}px 收起抽屉不遮住图纸`)
      await cdp.click('#mobile-tab-colors')
      await cdp.waitFor(`!!document.querySelector('.m-drawer.expanded')`, 5000, `${width}px 展开颜色面板`)
      await sleep(250)
      const expandedWidth = await cdp.eval(LAYOUT)
      check(`${width}px 展开面板没有横向溢出`, expandedWidth.scrollW <= expandedWidth.clientW + 1,
        `scrollW ${expandedWidth.scrollW} / clientW ${expandedWidth.clientW}`)
      await cdp.click('#mobile-tab-guide')
      await cdp.waitFor(`!document.querySelector('.m-drawer.expanded')`, 5000, `${width}px 收起面板`)
      if (width === 320 || width === 900) await cdp.shot(`mobile-${width}-guide.png`)
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 844, height: 390, deviceScaleFactor: 2, mobile: true,
    })
    await sleep(350)
    const landscape = await cdp.eval(LAYOUT)
    check('844×390 横屏没有横向溢出', landscape.scrollW <= landscape.clientW + 1,
      `scrollW ${landscape.scrollW} / clientW ${landscape.clientW}`)
    checkCanvasClear(landscape, '横屏收起抽屉不遮住图纸')
    check('横屏将至少 55% 视口留给图纸画布', landscape.canvas.height >= landscape.vh * 0.55,
      `画布 ${Math.round(landscape.canvas.height)} / 视口 ${landscape.vh}`)
    check('横屏收起操作区不超过视口四分之一', landscape.drawer.height <= landscape.vh * 0.25,
      `抽屉 ${Math.round(landscape.drawer.height)} / 视口 ${landscape.vh}`)
    const landscapeControls = await cdp.eval(`(() => {
      const controls = [['.m-compact-complete', 44], ['.m-compact-undo', 44], ['.m-drawer-toggle', 34]];
      return controls.map(([selector, minimumHeight]) => {
        const b = document.querySelector(selector);
        if (!b) return { selector, ok: false, width: 0, height: 0 };
        const r = b.getBoundingClientRect();
        return { selector, width: r.width, height: r.height,
          ok: r.width >= 40 && r.height >= minimumHeight && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
      });
    })()`)
    check('横屏操作保留触控空间且完整位于视口', landscapeControls.every((control) => control.ok),
      landscapeControls.map((control) => `${control.selector}: ${control.width}×${control.height}`).join(' / '))
    await cdp.shot('mobile-landscape.png')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    })
    await sleep(300)

    /* ---- 12. 无未捕获错误 ---- */
    const errs = await cdp.eval(`window.__mErrors ? window.__mErrors.length : 0`)
    check('手机端没有未捕获的页面错误', errs === 0, `捕获到 ${errs} 个`)

    /* ---- 13. 首页在手机视口下也是单列、不溢出 ---- */
    // 先多建两个项目，否则页面根本不够高、滚不动，重叠 bug 测不出来
    for (const d of ['b', 'c']) {
      await cdp.send('Page.navigate', { url: `${BASE}/?demo=${d}&auto=1` })
      await cdp.waitFor(`!!document.querySelector('.app.mobile')`, 40000, `示例 ${d} 建项目`)
      await sleep(2200) // 等识别 + 落库完成
    }
    await cdp.send('Page.navigate', { url: `${BASE}/` })
    await cdp.waitFor(`!!document.querySelector('.home')`, 30000, '首页')
    await sleep(900)
    const homeState = await cdp.eval(`(() => {
      const de = document.documentElement;
      const body = document.querySelector('.home-body');
      const cols = body ? getComputedStyle(body).gridTemplateColumns.split(' ').length : 0;
      const card = document.querySelector('.proj-card');
      return {
        scrollW: de.scrollWidth, clientW: de.clientWidth,
        cols,
        cardW: card ? Math.round(card.getBoundingClientRect().width) : 0,
        cardCount: document.querySelectorAll('.proj-card').length,
        scrollable: de.scrollHeight - innerHeight,
      };
    })()`)
    check(
      '手机端首页单列且不横向溢出',
      homeState.scrollW <= homeState.clientW + 1 && homeState.cols === 1,
      `列数 ${homeState.cols}，scrollW ${homeState.scrollW} vs ${homeState.clientW}，卡片宽 ${homeState.cardW}`,
    )
    check(
      '首页有多个项目、可以滚动（否则重叠 bug 测不到）',
      homeState.cardCount >= 3 && homeState.scrollable > 60,
      `${homeState.cardCount} 个卡片，可滚动 ${homeState.scrollable}px`,
    )
    await cdp.shot('mobile-5-home.png')

    /* ---- 14. 首页滚动时「新建项目」区不能压住项目列表 ---- */
    const heroPos = await cdp.eval(
      `(() => { const h = document.querySelector('.home-hero'); return h ? getComputedStyle(h).position : 'none' })()`,
    )
    check(
      '手机端「新建项目」区不吸顶（桌面双栏才需要 sticky）',
      heroPos === 'static',
      `position=${heroPos}`,
    )

    // 滚到「上传区底边」与「卡片可见范围」有交集的位置，量重叠像素
    const overlapAt = async (scrollY) => {
      await cdp.eval(`window.scrollTo(0, ${scrollY})`)
      await sleep(350)
      return cdp.eval(`(() => {
        const hero = document.querySelector('.home-hero');
        const cards = [...document.querySelectorAll('.proj-card')];
        if (!hero || cards.length === 0) return null;
        const h = hero.getBoundingClientRect();
        let covered = 0;
        for (const card of cards) {
          const c = card.getBoundingClientRect();
          covered = Math.max(covered, Math.min(h.bottom, c.bottom) - Math.max(h.top, c.top));
        }
        return {
          scrollY: Math.round(window.scrollY),
          heroTop: Math.round(h.top), heroBottom: Math.round(h.bottom),
          firstCardTop: Math.round(cards[0].getBoundingClientRect().top),
          covered: Math.round(Math.max(0, covered)),
        };
      })()`)
    }

    const probes = []
    for (const y of [0, 120, 240, 400, 99999]) {
      probes.push(await overlapAt(y))
    }
    const worst = probes.reduce((a, b) => (b && b.covered > (a?.covered ?? -1) ? b : a), probes[0])
    const scrolled = probes.some((p) => p && p.scrollY > 60)
    check(
      '首页滚动后上传区与项目卡片不重叠',
      scrolled && probes.every((p) => p !== null && p.covered === 0),
      worst
        ? `最差重叠 ${worst.covered}px（滚动到 ${worst.scrollY}px 时，上传区 ${worst.heroTop}~${worst.heroBottom}，首卡片顶 ${worst.firstCardTop}）`
        : '取不到元素',
    )

    // 上传区高度别把项目列表挤出首屏
    const heroH = await cdp.eval(
      `(() => { const h = document.querySelector('.home-hero'); return h ? Math.round(h.getBoundingClientRect().height) : 0 })()`,
    )
    check(
      '手机端「新建项目」区足够紧凑（≤45% 视口高）',
      heroH > 0 && heroH <= overflow.vh * 0.45,
      `上传区 ${heroH}px / 视口 ${overflow.vh}px`,
    )

    // 首屏要能看到至少一张项目卡片
    const firstCardVisible = await cdp.eval(`(() => {
      window.scrollTo(0, 0);
      const c = document.querySelector('.proj-card');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { top: Math.round(r.top), vh: innerHeight };
    })()`)
    check(
      '首屏就能看到第一张项目卡片',
      firstCardVisible !== null && firstCardVisible.top < firstCardVisible.vh,
      firstCardVisible ? `卡片顶 ${firstCardVisible.top} / 视口高 ${firstCardVisible.vh}` : '取不到卡片',
    )
    await cdp.shot('mobile-6-home-scrolled.png')

    /* ---- 15. 平板宽度（720~1080）也必须是静态定位 ---- */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 1000,
      deviceScaleFactor: 2,
      mobile: true,
    })
    await cdp.send('Page.navigate', { url: `${BASE}/` })
    await cdp.waitFor(`!!document.querySelector('.home')`, 30000, '平板首页')
    await sleep(800)
    const tablet = await cdp.eval(`(() => {
      const hero = document.querySelector('.home-hero');
      const body = document.querySelector('.home-body');
      return {
        pos: hero ? getComputedStyle(hero).position : 'none',
        cols: body ? getComputedStyle(body).gridTemplateColumns.split(' ').length : 0,
      };
    })()`)
    check(
      '平板宽度（900px，单列）上传区也是静态定位',
      tablet.pos === 'static' && tablet.cols === 1,
      `position=${tablet.pos}，列数=${tablet.cols}`,
    )
  } finally {
    try {
      cdp?.ws?.close()
    } catch {
      /* ignore */
    }
    proc.kill()
    killTree(proc.pid)
    await sleep(500)
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
  console.error('手机端测试异常：', e.message)
  process.exit(1)
})
