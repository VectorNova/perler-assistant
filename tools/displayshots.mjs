/**
 * 显示问题复现：在几个缩放级别 + 几个状态下截图，用来对比渲染效果。
 *
 *   node tools/displayshots.mjs [示例名] [--cells 104x104] [--codes "..."]
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
const PORT = 9700 + Math.floor(Math.random() * 200)
const SHOTS = path.resolve('_shots')
const demo = process.argv[2] ?? 'user.jpg'
const argOf = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}
const cells = argOf('--cells')
const codes = argOf('--codes')

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
      }, 240000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面异常')
    return r.result?.value
  }
  async waitFor(expr, timeoutMs = 180000, label = expr) {
    const t0 = Date.now()
    for (;;) {
      try {
        if (await this.eval(expr)) return true
      } catch {
        /* 加载中 */
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(SHOTS, { recursive: true })
    writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'))
    console.log(`  → _shots/${name}`)
  }
}

const clickTitle = (title) => `(() => {
  const b = document.querySelector('.canvas-tools button[title="' + ${JSON.stringify('X')}.replace('X', ${JSON.stringify('')}) + '"]');
  return !!b;
})()`

const zoomStep = (up) => `(() => {
  const btns = [...document.querySelectorAll('.canvas-tools button')];
  const b = btns.find((x) => x.title === ${JSON.stringify(up ? '放大' : '缩小')});
  if (!b) return false;
  b.click();
  return true;
})()`

const zoomPx = `(() => {
  const t = document.querySelector('.zoom-label')?.textContent ?? '';
  const m = t.match(/(\\d+)/);
  return m ? parseInt(m[1], 10) : -1;
})()`

const clickByText = (text, sel = 'button') => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find((b) => b.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text.replace(/\s+/g, ''))}));
  if (!el) return false;
  el.click();
  return true;
})()`

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome')
    process.exit(2)
  }
  const profile = mkdtempSync(path.join(tmpdir(), 'pa-disp-'))
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--hide-scrollbars',
      '--window-size=1680,1050',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `${BASE}/?demo=${encodeURIComponent(demo)}&auto=1`,
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
    await cdp.waitFor(`!!document.querySelector('.workspace')`, 180000, '工作台')
    await new Promise((r) => setTimeout(r, 1200))

    if (cells) {
      console.log(`按标注格数校准 ${cells}`)
      // 需要回到校准页才能用；这里直接改表单不现实，改用重新上传 + 校准
      console.log('  （跳过：请先用 ?demo 不带 auto 走校准页）')
    }
    if (codes) {
      await cdp.eval(clickByText('图纸', '.tabs button'))
      await new Promise((r) => setTimeout(r, 400))
      await cdp.eval(`(() => {
        const ta = document.querySelector('.code-input');
        if (!ta) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(codes)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('.btn-row button')].find((b) => b.textContent.includes('应用并重新识别'));
        btn && btn.click();
        return true;
      })()`)
      await new Promise((r) => setTimeout(r, 2500))
      console.log('已按图例约束色板')
    }

    /* 1. 看颜色分布 + 适应窗口（缩小到最小） */
    console.log('\n[1] 看颜色分布 + 适应窗口')
    await cdp.eval(clickByText('看颜色分布'))
    await new Promise((r) => setTimeout(r, 300))
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('.canvas-tools button')].find(x=>x.title==='适应窗口'); b&&b.click(); return true })()`)
    await cdp.eval(`(() => { document.querySelector('.color-row.total')?.click(); return true })()`)
    await new Promise((r) => setTimeout(r, 600))
    await cdp.shot('d1-fit-no-selection.png')

    /* 2. 选中一个颜色（看压暗 + 高亮） */
    console.log('\n[2] 选中一个颜色')
    await cdp.eval(`(() => { document.querySelectorAll('.color-rows .color-row')[0]?.click(); return true })()`)
    await new Promise((r) => setTimeout(r, 500))
    await cdp.shot('d2-fit-selected.png')

    /* 3. 进指引、标完一整块（看「已完成」的叠加色） */
    console.log('\n[3] 指引模式，标完当前色块')
    await cdp.eval(clickByText('开始拼豆指引'))
    await new Promise((r) => setTimeout(r, 600))
    await cdp.shot('d3-guide-region.png')
    await cdp.eval(clickByText('这一块拼好了'))
    await new Promise((r) => setTimeout(r, 700))
    await cdp.shot('d4-after-region-done.png')

    /* 4. 放大若干级，看分区线 */
    console.log('\n[4] 逐级放大看分区线')
    for (let i = 0; i < 6; i++) {
      await cdp.eval(zoomStep(true))
      await new Promise((r) => setTimeout(r, 250))
    }
    console.log(`  当前缩放 ${await cdp.eval(zoomPx)} px/格`)
    await cdp.shot('d5-zoomed-in.png')
    for (let i = 0; i < 5; i++) {
      await cdp.eval(zoomStep(true))
      await new Promise((r) => setTimeout(r, 200))
    }
    console.log(`  当前缩放 ${await cdp.eval(zoomPx)} px/格`)
    await cdp.shot('d6-zoomed-more.png')

    /* 5. 缩到最小看有无异常色 */
    console.log('\n[5] 缩到最小')
    for (let i = 0; i < 14; i++) {
      await cdp.eval(zoomStep(false))
      await new Promise((r) => setTimeout(r, 120))
    }
    console.log(`  当前缩放 ${await cdp.eval(zoomPx)} px/格`)
    await cdp.shot('d7-zoomed-out.png')
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
  console.error('异常：', e.message)
  process.exit(1)
})
