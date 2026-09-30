/**
 * 图例读取的调试工具 —— 在真实图纸上跑一遍并画出检测框，供人工核对。
 *
 *   node tools/legend.mjs "<图片路径>" <图案底边y> [向下找多少像素]
 *
 * 为什么要在浏览器里跑而不是 Node：
 * 浏览器原生能解 JPEG/PNG，Node 不行（要引依赖）。这里把 legend.ts 用 esbuild
 * 打成一个 IIFE 注入页面，页面里用 canvas 取 ImageData 再调用，
 * 顺便直接把调试图画出来 —— 检测框不对的话一眼就能看见。
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
const SHOTS = path.resolve('_shots')
const ROOT = path.resolve('..') // 工作区根目录，两张测试图在这里
const CDP_PORT = 9700 + Math.floor(Math.random() * 200)

const imgArg = process.argv[2] ?? '奥黛塔图纸.jpg'
const fromY = Number(process.argv[3] ?? 0)
const maxBand = Number(process.argv[4] ?? 400)
const imgName = path.basename(imgArg)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.html': 'text/html; charset=utf-8',
}

function startServer(root) {
  const server = createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent((req.url || '/').split('?')[0])
      if (rel === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><meta charset="utf-8"><title>legend debug</title><body></body>')
        return
      }
      const file = path.join(root, rel)
      if (!file.startsWith(root)) {
        res.writeHead(403).end()
        return
      }
      const s = await stat(file)
      if (!s.isFile()) throw new Error('not a file')
      const body = await readFile(file)
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
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
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails).slice(0, 300),
      )
    }
    return r.result?.value
  }
}

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome')
    process.exit(2)
  }
  const target = path.join(ROOT, imgName)
  if (!existsSync(target)) {
    console.error(`找不到图片：${target}`)
    process.exit(2)
  }

  // 1. 打包含有 legend.ts 的 IIFE
  const bundled = await build({
    entryPoints: [path.resolve('tools/legend-entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    logLevel: 'warning',
  })
  const script = bundled.outputFiles[0].text
  console.log(`bundle: ${(script.length / 1024).toFixed(0)} KB`)

  // 2. 起静态服务器（根目录 = 工作区）
  const { server, port } = await startServer(ROOT)
  const url = `http://127.0.0.1:${port}/`
  console.log(`server: ${url}\n图片: ${imgName}   fromY=${fromY} maxBand=${maxBand}\n`)

  const profile = mkdtempSync(path.join(tmpdir(), 'pa-legend-'))
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
      url,
    ],
    { stdio: 'ignore' },
  )

  try {
    let t = null
    for (let i = 0; i < 120 && !t; i++) {
      await sleep(250)
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
        t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      } catch {
        /* 还没起来 */
      }
    }
    if (!t) throw new Error('连不上调试端口')
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    const cdp = new CDP(ws)
    await cdp.send('Runtime.enable')
    await sleep(500)

    // 3. 注入 bundle
    await cdp.eval(script)
    const ok = await cdp.eval(`!!window.__legend`)
    if (!ok) throw new Error('bundle 注入失败')

    // 4. 加载图片 → 检测 → 画调试图 → 返回裁切放大的预览
    const out = await cdp.eval(`(async () => {
      const img = new Image();
      img.src = '/' + ${JSON.stringify(imgName)};
      await img.decode();
      const W = img.naturalWidth, H = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, W, H);

      const t0 = performance.now();
      const res = window.__legend.detectLegendSwatches(data, {
        fromY: ${fromY}, maxBand: ${maxBand},
      });
      const ms = performance.now() - t0;

      // 调试图：原尺寸画框，再裁到图例带并放大
      const dbg = window.__legend.drawLegendDebug(data, res);
      const c1 = document.createElement('canvas');
      c1.width = W; c1.height = H;
      c1.getContext('2d').putImageData(dbg, 0, 0);

      const pad = 24;
      const cy0 = Math.max(0, res.bandTop - pad);
      const cy1 = Math.min(H, res.bandBottom + pad);
      const ch = cy1 - cy0;
      const scale = Math.min(2, Math.max(0.25, 1700 / W));
      const c2 = document.createElement('canvas');
      c2.width = Math.round(W * scale);
      c2.height = Math.round(ch * scale);
      const g2 = c2.getContext('2d');
      g2.imageSmoothingEnabled = false;
      g2.drawImage(c1, 0, cy0, W, ch, 0, 0, c2.width, c2.height);

      return {
        W, H, ms,
        band: [res.bandTop, res.bandBottom],
        count: res.swatches.length,
        debug: res.debug,
        codes: res.codes,
        ambiguous: res.ambiguous,
        swatches: res.swatches.map((s) => ({
          x: s.x, y: s.y, w: s.w, h: s.h,
          rgb: s.rgb.join(','),
          code: s.code,
          delta: Number(s.delta.toFixed(2)),
          runnerUp: s.runnerUpCode + '(' + s.runnerUpDelta.toFixed(2) + ')',
        })),
        png: c2.toDataURL('image/png'),
      };
    })()`)

    console.log(`图片 ${out.W}×${out.H}   检测耗时 ${out.ms.toFixed(0)} ms`)
    console.log(`图例带 y=${out.band[0]}..${out.band[1]}   检出 ${out.count} 个色块`)
    if (out.debug) {
      const d = out.debug
      console.log(
        `掩码像素 ${d.maskPixels}   连通域 ${d.blobs}   被拒：太小 ${d.rejected.small} / 太大 ${d.rejected.big} / ` +
          `填充率 ${d.rejected.fill} / 长宽比 ${d.rejected.aspect} / 尺寸 ${d.rejected.size}`,
      )
    }
    console.log('')
    if (out.swatches.length > 0) {
      console.log('  #  位置(w×h)        取到的颜色       色差  第二近(色差)      映射色号')
      out.swatches.forEach((s, i) => {
        console.log(
          `  ${String(i + 1).padStart(2)}  ${String(s.x).padStart(5)},${String(s.y).padStart(5)} ` +
            `${String(s.w).padStart(3)}×${String(s.h).padStart(3)}  ` +
            `rgb(${s.rgb.padEnd(14)})  ${String(s.delta).padStart(5)}  ` +
            `${s.runnerUp.padEnd(16)}${s.code}`,
        )
      })
    }
    console.log(`\n色号（${out.codes.length} 个）：${out.codes.join(' ')}`)
    if (out.ambiguous.length) {
      console.log(`\n⚠ 近色歧义 ${out.ambiguous.length} 个（颜色上分不清，需要读文字确认）：`)
      for (const a of out.ambiguous) {
        console.log(`   ${a.code} ↔ ${a.other}  差 ${a.delta.toFixed(2)}  位置 ${a.at}`)
      }
    } else {
      console.log('\n没有近色歧义')
    }

    mkdirSync(SHOTS, { recursive: true })
    const png = Buffer.from(out.png.split(',')[1], 'base64')
    const outFile = path.join(SHOTS, `legend-${imgName.replace(/\.[^.]+$/, '')}.png`)
    writeFileSync(outFile, png)
    console.log(`\n调试图：${outFile}`)
    ws.close()
  } finally {
    try {
      await new Promise((r) => server.close(r))
    } catch {
      /* ignore */
    }
    proc.kill()
    try {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* ignore */
    }
    await sleep(400)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error('失败：', e.message)
  process.exit(1)
})
