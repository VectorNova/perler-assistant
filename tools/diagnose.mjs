/**
 * 对某张图纸跑一遍识别并打印诊断结论。
 *
 *   node tools/diagnose.mjs [示例名] [--auto]
 *
 * 不带 --auto 时停在网格校准页，把自动识别的格距/行列/置信度、实时预览的
 * 颜色数与粒数都打出来，并截图到 _shots/。这是排查「识别不理想」的入口。
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
const PORT = 9500 + Math.floor(Math.random() * 300)
const SHOTS = path.resolve('_shots')
const demo = process.argv[2] ?? 'user.jpg'
const auto = process.argv.includes('--auto')
const cellsArg = process.argv.indexOf('--cells')
const cells =
  cellsArg >= 0 && process.argv[cellsArg + 1]
    ? process.argv[cellsArg + 1].split('x').map(Number)
    : null

function killTree(pid) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面异常')
    return r.result?.value
  }
  async waitFor(expr, timeoutMs = 120000, label = expr) {
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
  }
}

const textOf = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '').replace(/\\s+/g,' ').trim()`

const clickByText = (text, sel = 'button') => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find((b) => b.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text.replace(/\s+/g, ''))}));
  if (!el) return false;
  el.click();
  return true;
})()`

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome/Edge')
    process.exit(2)
  }
  const profile = mkdtempSync(path.join(tmpdir(), 'pa-diag-'))
  const url = `${BASE}/?demo=${encodeURIComponent(demo)}${auto ? '&auto=1' : ''}`
  console.log(`打开 ${url}\n`)

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
      url,
    ],
    { stdio: 'ignore' },
  )

  let cdp
  try {
    let target = null
    for (let i = 0; i < 100 && !target; i++) {
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

    if (auto) {
      await cdp.waitFor(`!!document.querySelector('.workspace')`, 180000, '工作台')
      await new Promise((r) => setTimeout(r, 1200))
      console.log('=== 工作台 ===')
      console.log('图纸信息：', await cdp.eval(textOf('.topbar-name')))
      console.log('颜色统计：', await cdp.eval(textOf('.panel-title .muted')))
      console.log('颜色行数：', await cdp.eval(`document.querySelectorAll('.color-rows .color-row').length`))
      console.log('总豆子  ：', await cdp.eval(textOf('.color-row.total .count')))
      console.log('总进度  ：', await cdp.eval(textOf('.stage-progress')))
      await cdp.shot(`diagnose-${demo.replace(/\W+/g, '_')}-work.png`)
      console.log(`\n截图：_shots/diagnose-${demo.replace(/\W+/g, '_')}-work.png`)
      return
    }

    await cdp.waitFor(`!!document.querySelector('.calibrate-panel')`, 180000, '校准页')
    await new Promise((r) => setTimeout(r, 3000))
    console.log('=== 网格自动识别 ===')
    console.log(await cdp.eval(textOf('.detect-hint')))

    if (cells && cells.length === 2 && cells[0] > 0) {
      console.log(`\n=== 按标注格数校准 ${cells[0]}×${cells[1]} ===`)
      const typed = await cdp.eval(`(() => {
        const ins = [...document.querySelectorAll('.count-row input')];
        if (ins.length < 2) return 'no-input';
        const set = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, String(v));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(ins[0], ${cells[0]});
        set(ins[1], ${cells[1]});
        const btn = [...document.querySelectorAll('.count-row button')][0];
        if (!btn) return 'no-button';
        btn.click();
        return 'ok';
      })()`)
      await new Promise((r) => setTimeout(r, 1200))
      console.log(`点击结果：${typed}`)
      console.log(await cdp.eval(textOf('.detect-hint')))
      const dbg = await cdp.eval(textOf('.debug-body'))
      if (dbg) console.log('诊断：' + dbg)
    }

    console.log('\n=== 实时预览识别 ===')
    console.log(await cdp.eval(textOf('.summary')))
    console.log('\n=== 校准表单当前值 ===')
    console.log(
      await cdp.eval(`[...document.querySelectorAll('.grid-form .field')]
        .map((f) => f.querySelector('span').textContent + '=' + f.querySelector('input').value)
        .join('  ')`),
    )
    const shot = `diagnose-${demo.replace(/\W+/g, '_')}${cells ? '-cells' : ''}.png`
    await cdp.shot(shot)
    console.log(`\n截图：_shots/${shot}`)

    // 直接确认识别，看最终的颜色数与粒数
    if (process.argv.includes('--confirm')) {
      await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('开始识别图纸'));
        b && b.click();
        return true;
      })()`)
      await cdp.waitFor(`!!document.querySelector('.workspace')`, 180000, '工作台')
      await new Promise((r) => setTimeout(r, 1500))
      console.log('\n=== 识别结果 ===')
      console.log('图纸信息：', await cdp.eval(textOf('.topbar-name')))
      console.log('颜色统计：', await cdp.eval(textOf('.panel-title .muted')))
      console.log('总豆子  ：', await cdp.eval(textOf('.color-row.total .count')))
      await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('.tabs button')].find((x) => x.textContent.includes('图纸'));
        b && b.click(); return true;
      })()`)
      await new Promise((r) => setTimeout(r, 600))
      console.log('识别质量：', await cdp.eval(textOf('.settings')))
      await cdp.shot(`diagnose-${demo.replace(/\W+/g, '_')}-work2.png`)

      // 可选：按图例色号约束色板后重新识别
      const codesIdx = process.argv.indexOf('--codes')
      const codes = codesIdx >= 0 ? process.argv[codesIdx + 1] : null
      const noBlank = process.argv.includes('--no-blank')
      if (codes || noBlank) {
        if (noBlank) {
          // 「贴边空白当作不拼」在「显示」面板里（不是「图纸」）
          await cdp.eval(clickByText('显示', '.tabs button'))
          await new Promise((r) => setTimeout(r, 500))
          const toggled = await cdp.eval(`(() => {
            const labels = [...document.querySelectorAll('.settings .checkbox')];
            const l = labels.find((x) => x.textContent.includes('贴边空白'));
            if (!l) return 'no-checkbox';
            const cb = l.querySelector('input');
            const before = cb.checked;
            if (before) cb.click();
            return 'before=' + before + ' after=' + cb.checked;
          })()`)
          console.log('「贴边空白当作不拼」开关：', toggled)
          await new Promise((r) => setTimeout(r, 1500))
        }
        if (codes) {
          await cdp.eval(clickByText('图纸', '.tabs button'))
          await new Promise((r) => setTimeout(r, 500))
          const filled = await cdp.eval(`(() => {
            const ta = document.querySelector('.code-input');
            if (!ta) return 'no-textarea';
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, ${JSON.stringify(codes)});
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            const btn = [...document.querySelectorAll('.btn-row button')].find((b) => b.textContent.includes('应用并重新识别'));
            if (!btn) return 'no-button';
            btn.click();
            return 'ok';
          })()`)
          await new Promise((r) => setTimeout(r, 2500))
          console.log(`\n=== 按图例色号约束色板（${filled}）===`)
        }
        console.log('约束说明：', await cdp.eval(textOf('.detect-hint')))
        console.log('颜色统计：', await cdp.eval(textOf('.panel-title .muted')))
        console.log('总豆子  ：', await cdp.eval(textOf('.color-row.total .count')))
        console.log(
          '色号体系：',
          await cdp.eval(
            `[...document.querySelectorAll('.seg-row .btn')].map((b) => b.textContent.trim() + (b.classList.contains('active') ? '(选中)' : '')).join('  ')`,
          ),
        )
        console.log(
          '识别出的色号：',
          await cdp.eval(
            `[...document.querySelectorAll('.color-rows .color-row')].map((r) => {
               const c = r.querySelector('.code')?.textContent?.trim() ?? '';
               const n = r.querySelector('.count')?.textContent?.trim() ?? '';
               return c + ':' + n;
             }).join(' ')`,
          ),
        )
        await cdp.shot(`diagnose-${demo.replace(/\W+/g, '_')}-constrained.png`)

        /* ---- 项目往返：回首页再打开，参数与进度必须原样恢复 ---- */
        console.log('\n=== 项目往返（保存 → 回首页 → 再打开）===')
        await new Promise((r) => setTimeout(r, 1200)) // 等自动保存
        await cdp.send('Page.navigate', { url: `${BASE}/` })
        await cdp.waitFor(`!!document.querySelector('.proj-card')`, 20000, '首页项目卡片')
        await new Promise((r) => setTimeout(r, 600))
        const homeCard = await cdp.eval(textOf('.proj-card'))
        console.log('项目卡片：', homeCard.slice(0, 120))
        console.log('总进程  ：', await cdp.eval(textOf('.overall')))
        await cdp.shot('diagnose-home-project.png')

        await cdp.eval(`(() => {
          const b = [...document.querySelectorAll('.proj-actions .btn')].find((x) => x.textContent.includes('继续拼') || x.textContent.includes('开始拼'));
          b && b.click(); return true;
        })()`)
        await cdp.waitFor(`!!document.querySelector('.workspace')`, 20000, '重新打开项目')
        await new Promise((r) => setTimeout(r, 1500))
        console.log('重新打开后：')
        console.log('  识别信息：', await cdp.eval(textOf('.settings')))
        await cdp.eval(clickByText('图纸', '.tabs button'))
        await new Promise((r) => setTimeout(r, 400))
        console.log('  图纸面板：', await cdp.eval(textOf('.settings')))
        console.log('  色号原文：', await cdp.eval(`document.querySelector('.code-input')?.value?.slice(0, 70) ?? '(无)'`))
        console.log('  颜色统计：', await cdp.eval(textOf('.panel-title .muted')))
        await cdp.shot(`diagnose-${demo.replace(/\W+/g, '_')}-reopened.png`)
      }
    }
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
  console.error('诊断异常：', e.message)
  process.exit(1)
})
