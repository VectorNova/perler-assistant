/** Run independently rendered OCR fixtures in a real browser Canvas environment. */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const browsers = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean)
const browser = browsers.find(existsSync)
if (!browser) throw new Error('OCR 浏览器回归需要 Chrome/Chromium；可用 CHROME_PATH 指定。')
const dir = path.resolve('node_modules/.cache/perler-verify-ocr')
mkdirSync(dir, { recursive: true })
await build({ entryPoints: ['tools/verify-ocr-entry.ts'], bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'test.js'), logLevel: 'warning' })
const html = path.join(dir, 'test.html')
writeFileSync(html, `<html><body><pre id="result">pending</pre><script>${readFileSync(path.join(dir, 'test.js'), 'utf8')}</script></body></html>`)
let total = 0, passed = 0
for (const mode of ['canvas', 'static']) {
  const profile = path.join(dir, `profile-${process.pid}-${mode}`)
  const target = pathToFileURL(html)
  if (mode === 'static') target.searchParams.set('static', '1')
  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn(browser, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', `--user-data-dir=${profile}`, '--dump-dom', target.href], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    const timeout = setTimeout(() => { proc.kill(); reject(new Error('OCR browser regression timed out')) }, 30000)
    proc.stdout.on('data', (chunk) => { output += chunk })
    proc.stderr.on('data', (chunk) => { errors += chunk })
    proc.on('error', (error) => { clearTimeout(timeout); reject(error) })
    proc.on('close', (code) => { clearTimeout(timeout); code === 0 ? resolve(output) : reject(new Error(errors || `Chrome exited ${code}`)) })
  })
  const match = stdout.match(/<pre id="result">(.*?)<\/pre>/s)
  if (!match || match[1] === 'pending') throw new Error('OCR browser did not return fixture results')
  const report = JSON.parse(match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'))
  if (report.staticOnly !== (mode === 'static')) throw new Error('OCR browser used the wrong template mode')
  for (const check of report.checks) console.log(`${check.ok ? '✅ PASS' : '❌ FAIL'} [${mode}] ${check.name} — ${check.detail}`)
  total += report.checks.length
  passed += report.checks.filter((check) => check.ok).length
  if (!profile.startsWith(dir + path.sep)) throw new Error('Unexpected OCR test profile path')
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* Chrome may release profile handles shortly after exit. */ }
}
console.log(`结果：${passed}/${total} 通过`)
if (passed < total) process.exitCode = 1
