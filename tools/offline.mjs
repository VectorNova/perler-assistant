/**
 * 离线能力测试 —— 「去拼豆不带电脑」这个场景的核心保障。
 *
 *   node tools/offline.mjs
 *
 * 做法：自己起一个静态服务器托管 dist/，用无头 Chrome 打开、
 * 等 service worker 装好并预缓存完成，然后**把服务器关掉**再刷新页面。
 * 如果 app 还能正常渲染、还能取到示例图纸，就说明离线可用。
 *
 * 为什么不用 CDP 的 Network.emulateNetworkConditions：那个是按 target 生效的，
 * 而 service worker 是独立 target，模拟离线不一定作用到 SW 自己的 fetch 上，
 * 测试可能「假通过」。真把服务器关掉最可信，也不依赖模拟语义。
 *
 * 注意：service worker 要求安全上下文，http://127.0.0.1 算 localhost，是允许的。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
const DIST = path.resolve('dist')
const SHOTS = path.resolve('_shots')
const CDP_PORT = 9600 + Math.floor(Math.random() * 190)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  return !!ok
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

/** 极简静态服务器（只用于这个测试，不留依赖） */
function startStatic(root, prefix = '/') {
  const server = createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent((req.url || '/').split('?')[0])
      // 构建时若带 BASE_PATH（GitHub Pages 子路径），请求会带前缀，先剥掉。
      // 剥完可能变成空串（请求正好是 "/perler-assistant/"），所以两种都要补 index.html
      if (prefix !== '/' && rel.startsWith(prefix)) rel = rel.slice(prefix.length)
      if (rel === '' || rel.endsWith('/')) rel += 'index.html'
      const file = path.join(root, rel)
      if (!file.startsWith(root)) {
        res.writeHead(403).end()
        return
      }
      const s = await stat(file)
      if (!s.isFile()) throw new Error('not a file')
      const body = await readFile(file)
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        // service worker 脚本不能被缓存，否则更新不了
        'Cache-Control': file.endsWith('sw.js') ? 'no-store' : 'no-cache',
      })
      res.end(body)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404')
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 从 dist/index.html 推断构建用的 base：本地是 "/"，GitHub Pages 是 "/perler-assistant/" */
async function detectPrefix() {
  try {
    const html = await readFile(path.join(DIST, 'index.html'), 'utf8')
    const m = /src="([^"]*?)assets\//.exec(html)
    return m ? m[1] : '/'
  } catch {
    return '/'
  }
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
      await sleep(150)
    }
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(SHOTS, { recursive: true })
    writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'))
    console.log(`  → _shots/${name}`)
  }
}

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome')
    process.exit(2)
  }
  if (!existsSync(path.join(DIST, 'sw.js'))) {
    console.error('dist/sw.js 不存在，先跑 npm run build')
    process.exit(2)
  }

  const prefix = await detectPrefix()
  const { server, port } = await startStatic(DIST, prefix)
  const base = `http://127.0.0.1:${port}${prefix}`
  console.log(`静态服务器: ${base}（构建前缀 "${prefix}"）\n`)

  const profile = mkdtempSync(path.join(tmpdir(), 'pa-offline-'))
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--window-size=1280,900',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      base,
    ],
    { stdio: 'ignore' },
  )

  let cdp
  try {
    let target = null
    for (let i = 0; i < 120 && !target; i++) {
      await sleep(250)
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
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

    /* ---- 1. SW 注册并接管 ---- */
    check('页面加载成功', await cdp.waitFor(`!!document.querySelector('.app')`, 40000, 'app'))
    const swState = await cdp.eval(`(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const reg = await navigator.serviceWorker.ready;
      // ready 之后 controller 可能还没生效，等一小会儿
      for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return {
        supported: true,
        scope: reg.scope,
        active: !!reg.active,
        state: reg.active ? reg.active.state : '',
        controlled: !!navigator.serviceWorker.controller,
      };
    })()`)
    check(
      'service worker 已注册并接管页面',
      swState.supported && swState.active && swState.controlled,
      `scope=${swState.scope} state=${swState.state} controlled=${swState.controlled}`,
    )

    /* ---- 2. 预缓存要装完 ---- */
    const cacheInfo = await cdp.eval(`(async () => {
      const names = await caches.keys();
      if (names.length === 0) return { names: [], count: 0 };
      const c = await caches.open(names[0]);
      const keys = await c.keys();
      return {
        names,
        count: keys.length,
        urls: keys.map((k) => new URL(k.url).pathname).sort(),
      };
    })()`)
    // 装缓存是异步的，轮询等到稳定
    let waited = 0
    let info = cacheInfo
    while (info.count < 10 && waited < 30000) {
      await sleep(500)
      waited += 500
      info = await cdp.eval(`(async () => {
        const names = await caches.keys();
        if (names.length === 0) return { names: [], count: 0, urls: [] };
        const c = await caches.open(names[0]);
        const keys = await c.keys();
        return { names, count: keys.length, urls: keys.map((k) => new URL(k.url).pathname).sort() };
      })()`)
    }
    check(
      '预缓存已经装好（含 index.html、JS 和图标）',
      info.count >= 10 &&
        info.urls.some((u) => u.endsWith('/index.html')) &&
        info.urls.some((u) => /\/assets\/index-.*\.js$/.test(u)) &&
        info.urls.some((u) => u.endsWith('/logo-96.png')),
      `缓存 ${info.names.join(',')} 共 ${info.count} 个：${info.urls.slice(0, 4).join(' ')} …`,
    )

    const hasSamples = info.urls.filter((u) => u.includes('/samples/')).length
    check('示例图纸也在缓存里（离线也能试示例）', hasSamples >= 4, `${hasSamples} 张`)

    await cdp.shot('offline-1-online.png')

    /* ---- 3. 关掉服务器 ---- */
    console.log('\n>>> 关闭静态服务器，模拟「没网 / 没电脑」\n')
    await new Promise((resolve) => server.close(resolve))
    await sleep(500)
    const serverDown = await fetch(base).then(
      () => false,
      () => true,
    )
    check('服务器确实已关闭', serverDown)

    /* ---- 4. 断网后刷新，app 必须还能用 ---- */
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(1500)
    const offlineState = await cdp.eval(`(() => ({
      hasApp: !!document.querySelector('.app'),
      title: document.title,
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 70),
      controlled: !!navigator.serviceWorker.controller,
    }))()`)
    check(
      '断网后刷新，app 依然渲染',
      offlineState.hasApp && offlineState.text.length > 5,
      `controlled=${offlineState.controlled} 内容="${offlineState.text}"`,
    )

    // 图标也应该能从缓存取到（否则界面是破图）
    const iconOffline = await cdp.eval(`(async () => {
      const PREFIX = ${JSON.stringify(prefix)};
      try {
        const r = await fetch(PREFIX + 'logo-96.png');
        const b = await r.blob();
        return { ok: r.ok, size: b.size, status: r.status };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    })()`)
    check(
      '断网后图标仍可取到（来自 SW 缓存）',
      iconOffline.ok === true && iconOffline.size > 1000,
      `size=${iconOffline.size}`,
    )

    // 示例图纸也一样
    const sampleOffline = await cdp.eval(`(async () => {
      const PREFIX = ${JSON.stringify(prefix)};
      try {
        const r = await fetch(PREFIX + 'samples/a.png');
        return { ok: r.ok, size: (await r.blob()).size };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    })()`)
    check(
      '断网后示例图纸仍可取到',
      sampleOffline.ok === true && sampleOffline.size > 1000,
      `size=${sampleOffline.size}`,
    )

    // 走完整条「新建项目 → 校准 → 识别」的路：示例 a 在缓存里，断网也该能一路走通
    // 注意：不带 ?auto=1 时，点示例先到**校准页**，要再点「开始识别图纸」才到工作台
    const clicked = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.demo-row .btn')].find((x) => x.textContent.includes('标准图纸'));
      if (b) b.click();
      return !!b;
    })()`)
    const waitForSelector = (sel, ms) =>
      cdp.eval(
        `new Promise((resolve) => {
          const t0 = Date.now();
          const tick = () => {
            if (document.querySelector(${JSON.stringify(sel)})) return resolve('ok');
            const err = document.querySelector('.error-box');
            if (err) return resolve('错误：' + err.textContent.slice(0, 60));
            if (Date.now() - t0 > ${ms}) return resolve('超时');
            setTimeout(tick, 200);
          };
          tick();
        })`,
      )
    const calibrate = await waitForSelector('.calibrate', 30000)
    check(
      '断网状态下点示例能读到图纸并进入校准页',
      clicked === true && calibrate === 'ok',
      calibrate === 'ok' ? '已进入校准页' : String(calibrate),
    )

    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('开始识别图纸'));
      if (b) b.click();
      return !!b;
    })()`)
    const workspace = await waitForSelector('.workspace', 40000)
    const cellCount = await cdp.eval(
      `document.querySelector('.color-row.total .count')?.textContent?.trim() ?? ''`,
    )
    check(
      '断网状态下能一路完成识别进入工作台',
      workspace === 'ok' && cellCount.length > 0,
      workspace === 'ok' ? `识别出 ${cellCount} 粒` : String(workspace),
    )
    await cdp.shot('offline-2-recognized.png')

    /* ---- 5. 恢复网络后仍然正常（缓存不该把新版挡住） ---- */
    const back = await startStatic(DIST, prefix)
    await sleep(300)
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(1500)
    const recovered = await cdp.eval(`!!document.querySelector('.app')`)
    check('恢复网络后刷新仍然正常', recovered === true)
    await new Promise((r) => back.server.close(r))
  } finally {
    try {
      await new Promise((r) => server.close(r))
    } catch {
      /* 已经关了 */
    }
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
  console.error('离线测试异常：', e.message)
  process.exit(1)
})
