/**
 * 手机端布局端到端测试。
 *
 *   node tools/mobile.mjs
 *
 * 用 CDP 的 setDeviceMetricsOverride 强制成手机视口（而不是只缩窗口），
 * 这样才能真实触发 matchMedia('(max-width: 720px)')。
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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 180000)
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

    // 装未捕获错误钩子后再强制手机视口，然后重载
    await cdp.eval(`window.__mErrors = []; window.addEventListener('error', (e) => window.__mErrors.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__mErrors.push(String(e.reason))); true`)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    })
    await cdp.send('Page.navigate', { url: `${BASE}/?demo=a&auto=1` })
    await cdp.eval(`window.__mErrors = []; window.addEventListener('error', (e) => window.__mErrors.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__mErrors.push(String(e.reason))); true`)
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
    const layout = await cdp.eval(`(() => {
      const r = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
      return { canvas: r('.stage'), drawer: r('.m-drawer'), compact: r('.m-compact'), bar: r('.m-topbar') };
    })()`)
    check(
      '收起态画布占屏幕主体（≥55% 视口高）',
      layout.canvas >= overflow.vh * 0.55,
      `画布 ${layout.canvas} / 视口 ${overflow.vh}（顶栏 ${layout.bar}，抽屉 ${layout.drawer}）`,
    )

    /* ---- 4. 收起态就能看到关键信息和大按钮 ---- */
    const compact = await cdp.eval(textOf('.m-compact'))
    check(
      '收起态直接给出「开始拼豆指引」',
      compact.includes('开始拼豆指引'),
      compact.slice(0, 60),
    )
    await cdp.shot('mobile-1-browse.png')

    /* ---- 5. 进入指引：紧凑条给出色号 / 块粒数 / 大按钮 ---- */
    await cdp.eval(clickIn('.m-compact .btn', '开始拼豆指引'))
    await sleep(800)
    const compactGuide = await cdp.eval(textOf('.m-compact'))
    check(
      '进入指引后紧凑条显示当前色号与块内粒数',
      /第 \d+\/\d+ 种/.test(compactGuide) && /第 \d+\/\d+ 块/.test(compactGuide) && /粒/.test(compactGuide),
      compactGuide.slice(0, 90),
    )
    const markBtn = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.m-compact .btn')].find((x) => x.textContent.includes('这一块拼好了'));
      return b ? b.textContent.trim() : '';
    })()`)
    check('紧凑条里有「这一块拼好了（N 粒）」大按钮', /这一块拼好了（\d+ 粒）/.test(markBtn), markBtn)
    const bigBtnH = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.m-compact .btn')].find((x) => x.textContent.includes('这一块拼好了'));
      return b ? Math.round(b.getBoundingClientRect().height) : 0;
    })()`)
    check('大按钮的触摸高度 ≥ 48px', bigBtnH >= 48, `${bigBtnH}px`)
    await cdp.shot('mobile-2-guide.png')

    /* ---- 6. 点大按钮真的能拼（交互闭环） ---- */
    const before = await cdp.eval(`document.querySelector('.m-topbar-pct')?.textContent?.trim() ?? ''`)
    await cdp.eval(clickIn('.m-compact .btn', '这一块拼好了'))
    await sleep(900)
    const after = await cdp.eval(`document.querySelector('.m-topbar-pct')?.textContent?.trim() ?? ''`)
    check('点大按钮真的标记了这一块', before !== after, `${before} → ${after}`)

    /* ---- 7. 切「颜色」标签：自动展开并显示颜色列表 ---- */
    await cdp.eval(clickIn('.m-tab', '颜色'))
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
    await cdp.eval(clickIn('.m-tab', '显示'))
    await sleep(600)
    const displayOk = await cdp.eval(
      `!!document.querySelector('.m-drawer-body .settings .radio-row')`,
    )
    check('「显示」抽屉里有显示设置（手机端从画布条移到了这里）', displayOk === true)

    /* ---- 9. 切回「指引」：收起回紧凑条 ---- */
    await cdp.eval(clickIn('.m-tab', '指引'))
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
    await cdp.eval(clickIn('.m-drawer-toggle', '展开'))
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
      expandedState.expanded && expandedState.guide && expandedState.h > 200,
      `面板高 ${expandedState.h}px`,
    )
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
