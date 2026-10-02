/**
 * Verify real charts using the browser's original-resolution import/OCR pipeline.
 * Expected legend counts are read only after recognition; images stay external.
 *
 * node tools/verify-charts.mjs [image.png ...] [--system MARD221|MARD291]
 *                            [--report _shots/verify-charts.json]
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
let system = 'MARD221'
let reportPath = path.resolve('_shots/verify-charts.json')
const imagePaths = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--system') system = args[++i]
  else if (args[i] === '--report') reportPath = path.resolve(args[++i])
  else if (args[i].startsWith('--')) throw new Error(`Unknown option: ${args[i]}`)
  else imagePaths.push(path.resolve(args[i]))
}
if (!['MARD221', 'MARD291'].includes(system)) throw new Error('Invalid palette system')
if (!imagePaths.length) {
  imagePaths.push('D:/DeepSeek-harness/哥伦比亚图纸.png', 'D:/DeepSeek-harness/奥黛塔图纸.png')
}
for (const file of imagePaths) {
  if (!existsSync(file)) throw new Error(`Image does not exist: ${file}`)
}
const browserPath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => file && existsSync(file))
if (!browserPath) throw new Error('Chrome/Edge unavailable; set CHROME_PATH to a browser executable')

const bundle = await build({
  entryPoints: [path.resolve('tools/verify-charts-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  write: false,
  logLevel: 'warning',
})
const script = bundle.outputFiles[0].text
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><title>Chart verification</title>')
      return
    }
    const match = /^\/chart\/(\d+)$/.exec(url.pathname)
    const file = match && imagePaths[Number(match[1])]
    if (!file) {
      res.writeHead(404).end()
      return
    }
    const body = await readFile(file)
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream' })
    res.end(body)
  } catch (error) {
    res.writeHead(500).end(String(error))
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
const debugPort = 10000 + Math.floor(Math.random() * 2000)
const profile = mkdtempSync(path.join(tmpdir(), 'perler-chart-verify-'))
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, url,
], { stdio: 'ignore', windowsHide: true })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let ws
let messageId = 0
const pending = new Map()
const send = (method, params = {}) => {
  const id = ++messageId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 180000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? JSON.stringify(response.exceptionDetails))
  }
  return response.result.value
}
try {
  let target
  for (let i = 0; i < 120 && !target; i++) {
    if (browser.exitCode !== null) throw new Error(`Browser exited: ${browser.exitCode}`)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      target = targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl)
    } catch { /* Browser is starting. */ }
    if (!target) await delay(250)
  }
  if (!target) throw new Error('Cannot connect to headless browser')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    clearTimeout(call.timer)
    if (message.error) call.reject(new Error(JSON.stringify(message.error)))
    else call.resolve(message.result)
  })
  await send('Page.navigate', { url })
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(`location.href === ${JSON.stringify(url)} && document.readyState !== 'loading'`)) break
    if (attempt === 119) throw new Error('Verification page did not finish loading')
    await delay(100)
  }
  await evaluate(script)
  const reports = []
  let failed = false
  for (let i = 0; i < imagePaths.length; i++) {
    const file = path.basename(imagePaths[i])
    const report = await evaluate(`(async () => {
      const image = new Image();
      image.src = '/chart/${i}';
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const recognized = await window.__verifyCharts.analyzeChart(data, ${JSON.stringify(system)});
      const evaluation = window.__verifyCharts.evaluateChart(recognized, ${JSON.stringify(file)});
      return { file: ${JSON.stringify(file)}, ...recognized, evaluation };
    })()`)
    reports.push(report)
    const e = report.evaluation
    const matches = e.fixture && e.gridMatches && e.totalMatches && e.countsMatch
    if (e.fixture && !matches) failed = true
    console.log(`${matches ? 'PASS' : e.fixture ? 'FAIL' : 'UNLABELLED'} ${file}`)
    console.log(`  original ${report.image.width}×${report.image.height}; automatic grid ${report.grid.cols}×${report.grid.rows}; OCR ${JSON.stringify(report.ocr)}; ${report.elapsedMs}ms`)
    if (e.fixture) {
      console.log(`  legend count L1 error ${e.baselineCountL1Error} → ${e.countL1Error}; changed cells ${report.changedCells}`)
      for (const value of e.mismatches) console.log(`    ${value.code}: expected ${value.expected}, actual ${value.actual}`)
    }
  }
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify({ system, reports, pixelAccuracyVerified: false }, null, 2) + '\n')
  console.log(`Report: ${reportPath}`)
  console.log('Legend-count agreement does not prove every cell matches; per-cell ground truth is required for that claim.')
  process.exitCode = failed ? 1 : 0
} finally {
  for (const call of pending.values()) clearTimeout(call.timer)
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id: ++messageId, method: 'Browser.close' }))
    await delay(250)
  }
  ws?.close()
  if (browser.pid && browser.exitCode === null && process.platform === 'win32') {
    await new Promise((resolve) => {
      const stop = spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      stop.once('exit', resolve)
      stop.once('error', resolve)
    })
  } else browser.kill()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  const cleanupPath = path.resolve(profile)
  if (path.dirname(cleanupPath) !== path.resolve(tmpdir()) || !path.basename(cleanupPath).startsWith('perler-chart-verify-')) {
    throw new Error('Refusing to remove an unexpected browser profile directory')
  }
  try { rmSync(cleanupPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }) } catch { /* Browser teardown may retain a file lock. */ }
}
