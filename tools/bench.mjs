/**
 * 移动端算力基准：用 CDP 的 CPU 降频模拟手机，实测「识别图纸」要多久。
 *
 *   node tools/bench.mjs [示例名]
 *
 * 4x 大致相当于中端安卓机，6x 接近低端机 / 老 iPhone。
 * 只测「从点击到出结果」的端到端时间（含 React 渲染），因为那才是用户感受到的。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
const BASE = process.env.APP_URL ?? 'http://127.0.0.1:4173'
const PORT = 9900 + Math.floor(Math.random() * 90)
const demo = process.argv[2] ?? 'user.jpg'

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
      }, 300000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面异常')
    return r.result?.value
  }
  async waitFor(expr, timeoutMs = 300000, label = expr) {
    const t0 = Date.now()
    for (;;) {
      try {
        if (await this.eval(expr)) return Date.now() - t0
      } catch {
        /* 加载中 */
      }
      if (Date.now() - t0 > timeoutMs) {
        let dump = ''
        try {
          dump = await this.eval(
            `JSON.stringify({
              stage: document.querySelector('.workspace, .m-workspace') ? 'work'
                   : document.querySelector('.calibrate') ? 'calibrate'
                   : document.querySelector('.home') ? 'home' : '?',
              url: location.href,
              err: document.querySelector('.error-box')?.textContent ?? '',
              text: (document.body.innerText || '').replace(/\\s+/g,' ').slice(0, 260),
            })`,
          )
        } catch {
          /* ignore */
        }
        throw new Error(`等待超时：${label}\n  页面状态：${dump}`)
      }
      await new Promise((r) => setTimeout(r, 60))
    }
  }
}

const clickIn = (sel, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find((b) => b.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text)}));
  if (!el) return false; el.click(); return true;
})()`

const fillByName = (label, value) => `(() => {
  const field = [...document.querySelectorAll('.field, label')]
    .find((f) => f.textContent.includes(${JSON.stringify(label)}));
  if (!field) return false;
  const input = field.querySelector('input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(String(value))});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome')
    process.exit(2)
  }
  const profile = mkdtempSync(path.join(tmpdir(), 'pa-bench-'))
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--window-size=390,844', // 手机视口，顺带看布局
      '--device-scale-factor=3',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `${BASE}/?demo=${encodeURIComponent(demo)}`,
    ],
    { stdio: 'ignore' },
  )
  let cdp
  try {
    let target = null
    for (let i = 0; i < 120 && !target; i++) {
      await new Promise((r) => setTimeout(r, 250))
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

    console.log(`示例：${demo}  手机视口 390×844\n`)
    console.log('  降频   自动识别→进入工作台   按格数校准→进入工作台')
    console.log('  ' + '-'.repeat(54))

    for (const rate of [1, 4, 6]) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate })

      // --- A. 自动识别 ---
      await cdp.send('Page.navigate', { url: `${BASE}/?demo=${encodeURIComponent(demo)}` })
      await cdp.waitFor(`!!document.querySelector('.calibrate')`, 300000, '校准页')
      await new Promise((r) => setTimeout(r, 400))
      const t0 = Date.now()
      await cdp.eval(clickIn('button', '开始识别图纸'))
      await cdp.waitFor(`!!document.querySelector('.workspace, .m-workspace')`, 300000, '工作台')
      const autoMs = Date.now() - t0
      const autoInfo = await cdp.eval(
        `document.querySelector('.topbar .muted, .panel-title .muted')?.textContent?.trim() ?? ''`,
      )

      // --- B. 按标注格数校准（顺带量一下这条路的开销）---
      await cdp.send('Page.navigate', { url: `${BASE}/?demo=${encodeURIComponent(demo)}` })
      await cdp.waitFor(`!!document.querySelector('.calibrate')`, 300000, '校准页')
      await new Promise((r) => setTimeout(r, 400))
      await cdp.eval(fillByName('列数', 104))
      await cdp.eval(fillByName('行数', 104))
      await new Promise((r) => setTimeout(r, 200))
      const t1 = Date.now()
      await cdp.eval(clickIn('button', '按格数重算'))
      await new Promise((r) => setTimeout(r, 800))
      await cdp.eval(clickIn('button', '开始识别图纸'))
      await cdp.waitFor(`!!document.querySelector('.workspace, .m-workspace')`, 300000, '工作台')
      const cellsMs = Date.now() - t1

      console.log(
        `  ${String(rate + 'x').padStart(4)}   ${String(autoMs + ' ms').padStart(16)}   ${String(cellsMs + ' ms').padStart(20)}`,
      )
      if (rate === 1) console.log(`         （识别信息：${autoInfo.slice(0, 60)}）`)
    }

    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })

    // 移动端布局体检：工作台三栏在手机宽度下会不会溢出
    await cdp.send('Page.navigate', { url: `${BASE}/?demo=a&auto=1` })
    await cdp.waitFor(`!!document.querySelector('.workspace, .m-workspace')`, 300000, '工作台')
    await new Promise((r) => setTimeout(r, 800))
    const layout = await cdp.eval(`(() => {
      const de = document.documentElement;
      const ws = document.querySelector('.workspace, .m-workspace');
      const stage = document.querySelector('.stage');
      const L = document.querySelector('.panel.side.left');
      const R = document.querySelector('.panel.side.right');
      const r = (el) => el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
      return {
        viewport: { w: innerWidth, h: innerHeight },
        docScrollH: de.scrollHeight,
        bodyScrollH: document.body.scrollHeight,
        workspace: r(ws), stage: r(stage), left: r(L), right: r(R),
        workspaceOverflowY: ws ? getComputedStyle(ws).overflowY : '',
      };
    })()`)
    console.log('\n移动端布局体检（390×844）：')
    console.log('  ' + JSON.stringify(layout, null, 2).replace(/\n/g, '\n  '))
  } finally {
    try {
      cdp?.ws?.close()
    } catch {
      /* ignore */
    }
    proc.kill()
    killTree(proc.pid)
    await new Promise((r) => setTimeout(r, 600))
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error('基准测试异常：', e.message)
  process.exit(1)
})
