/** Real app import → calibration → IndexedDB → reload/open regression test.
 * npm run build; APP_URL=http://127.0.0.1:5188 node tools/import-charts.mjs [image.png ...]
 * Files are supplied through DOM.setFileInputFiles; no image is copied into public.
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

const appUrl = process.env.APP_URL ?? 'http://127.0.0.1:4173/'
const files = process.argv.slice(2).map((file) => path.resolve(file))
if (!files.length) files.push('D:/DeepSeek-harness/哥伦比亚图纸.png', 'D:/DeepSeek-harness/奥黛塔图纸.png')
for (const file of files) if (!existsSync(file)) throw new Error(`Image does not exist: ${file}`)
function pngDimensions(file) {
  const descriptor = openSync(file, 'r')
  try {
    const header = Buffer.alloc(24)
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length ||
      !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
  } finally { closeSync(descriptor) }
}
const browserPath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => file && existsSync(file))
if (!browserPath) throw new Error('Chrome/Edge unavailable; set CHROME_PATH')
const bundled = await build({
  entryPoints: [path.resolve('tools/verify-charts-entry.ts')],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2020', write: false,
})
const script = bundled.outputFiles[0].text
const profile = mkdtempSync(path.join(tmpdir(), 'perler-chart-import-'))
const debugPort = 12000 + Math.floor(Math.random() * 2000)
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1400,1000',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, appUrl,
], { stdio: 'ignore', windowsHide: true })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pending = new Map()
let ws
let id = 0
function send(method, params = {}) {
  const callId = ++id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`CDP timeout: ${method}`)) }, 120000)
    pending.set(callId, { resolve, reject, timer })
    ws.send(JSON.stringify({ id: callId, method, params }))
  })
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? 'Page exception')
  return response.result?.value
}
async function waitFor(expression, label, timeoutMs = 45000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { if (await evaluate(expression)) return } catch { /* Navigation resets the context. */ }
    await delay(150)
  }
  throw new Error(`Timeout waiting for ${label}`)
}
const click = (text, selector = 'button') => evaluate(`(() => {
  const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)});
  if (!element || element.disabled) return false; element.click(); return true;
})()`)
const readProject = (file) => evaluate(`(async () => {
  const request = indexedDB.open('perler-assistant');
  const db = await new Promise((resolve,reject) => { request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); });
  const read=(store,key)=>new Promise((resolve,reject)=> {
    const query=db.transaction(store).objectStore(store)[key === undefined ? 'getAll' : 'get'](key);
    query.onsuccess=()=>resolve(query.result);query.onerror=()=>reject(query.error);
  });
  try {
    const records=await read('patterns');
    const record=records.filter(r=>r.imageName===${JSON.stringify(file)}).at(-1);
    if(!record)return null;
    const meta=await read('projects',record.id);
    const image=await read('images',record.id);
    const report=window.__verifyCharts.summarizeStoredProject(record,meta);
    const evaluation=window.__verifyCharts.evaluateChart(report,${JSON.stringify(file)});
    return {...report,name:meta.name,imageSaved:!!image?.blob?.size,evaluation};
  } finally { db.close(); }
})()`)

const reports = []
try {
  let target
  for (let attempt = 0; attempt < 120 && !target; attempt++) {
    if (browser.exitCode !== null) throw new Error(`Browser exited: ${browser.exitCode}`)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      target = targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl)
    } catch { /* Browser startup. */ }
    if (!target) await delay(250)
  }
  if (!target) throw new Error('Cannot connect to browser')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve,reject) => {
    ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})
  })
  ws.addEventListener('message',(event) => {
    const message=JSON.parse(event.data)
    const call=pending.get(message.id)
    if (!call) return
    clearTimeout(call.timer);pending.delete(message.id)
    if(message.error)call.reject(new Error(JSON.stringify(message.error)));else call.resolve(message.result)
  })
  await send('Page.navigate',{url:appUrl})
  await waitFor(`!!document.querySelector('input[type=file]')`,'app home')
  await evaluate(script)
  let failed = false
  for (let i=0;i<files.length;i++) {
    const file=path.basename(files[i])
    const documentNode=await send('DOM.getDocument')
    const input=await send('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'input[type=file]'})
    if(!input.nodeId)throw new Error('App upload input missing')
    await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[files[i]]})
    await waitFor(`!!document.querySelector('.calibrate-panel .primary.big:not(:disabled)')`,'automatic grid/calibration')
    await evaluate(`document.querySelector('.calibrate-panel .primary.big').click()`)
    await waitFor(`!!document.querySelector('.color-row') && !!document.querySelector('.pattern-canvas')`,'work view',90000)
    await waitFor(`document.body.textContent.includes('项目已保存')`,'saved project')
    const before=await readProject(file)
    if(!before)throw new Error('Project missing from IndexedDB after import')
    const n=before.grid.cols*before.grid.rows
    const sourceDimensions=pngDimensions(files[i])
    const nativeDimensions=!sourceDimensions ||
      (before.image.width===sourceDimensions.width && before.image.height===sourceDimensions.height)
    const persisted=before.evidence.confidenceIsFloat32Array && before.evidence.confidenceLength===n &&
      before.evidence.confidenceValid && before.evidence.confidentCells>0 && !!before.evidence.recognition && before.imageSaved
    const recognized=before.evaluation.fixture && before.evaluation.gridMatches && before.evaluation.totalMatches && before.evaluation.countsMatch

    await send('Page.reload',{ignoreCache:true})
    await waitFor(`!!document.querySelector('input[type=file]') && !!document.querySelector('.proj-card')`,'saved-project home after reload')
    await evaluate(script)
    const opened=await evaluate(`(() => {
      const card=[...document.querySelectorAll('.proj-card')].find(e=>e.querySelector('.proj-thumb img')?.alt===${JSON.stringify(before.name)});
      const button=card&&[...card.querySelectorAll('button')].find(e=>['开始拼','继续拼','查看'].includes(e.textContent.trim()));
      if(!button)return false;button.click();return true;
    })()`)
    if(!opened)throw new Error(`Cannot reopen project ${before.name}`)
    await waitFor(`!!document.querySelector('.color-row')`,'restored work view')
    if(!await click('图纸'))throw new Error('Pattern information tab missing')
    await waitFor(`document.body.textContent.includes('已根据格内色号确认')`,'restored recognition summary')
    const after=await readProject(file)
    const stable=JSON.stringify(before.evidence)===JSON.stringify(after.evidence) && JSON.stringify(before.counts)===JSON.stringify(after.counts)
    const summaryRestored=await evaluate(`Array.from(document.body.textContent).filter(c=>c.trim()).join('').includes(${JSON.stringify('已根据格内色号确认'+before.ocr.recognizedCells+'格')})`)
    const shot=await send('Page.captureScreenshot',{format:'png'})
    mkdirSync('_shots',{recursive:true})
    writeFileSync(path.resolve(`_shots/import-chart-${i+1}.png`),Buffer.from(shot.data,'base64'))
    const ok=persisted && nativeDimensions && stable && summaryRestored && (recognized || !before.evaluation.fixture)
    if(!ok)failed=true
    reports.push({file,sourceDimensions,nativeDimensions,before,after,persisted,stable,summaryRestored,ok})
    console.log(`${ok?'PASS':'FAIL'} import/reload ${file}: grid ${before.grid.cols}×${before.grid.rows}, original size=${nativeDimensions}, legend counts=${!!recognized}, Float32 confidence=${persisted}, reload stable=${stable}, UI recognition restored=${summaryRestored}`)
    if(!await click('换一张') && !await click('← 首页'))throw new Error('Home button missing')
    await waitFor(`!!document.querySelector('input[type=file]')`,'upload input for next chart')
  }
  mkdirSync('_shots',{recursive:true})
  writeFileSync('_shots/import-charts.json',JSON.stringify({appUrl,reports,pixelAccuracyVerified:false},null,2)+'\n')
  process.exitCode=failed?1:0
} finally {
  for(const call of pending.values())clearTimeout(call.timer)
  if(ws?.readyState===WebSocket.OPEN){ws.send(JSON.stringify({id:++id,method:'Browser.close'}));await delay(250)}
  ws?.close()
  if(browser.pid && browser.exitCode===null && process.platform==='win32') {
    await new Promise((resolve) => {
      const stop=spawn('taskkill',['/PID',String(browser.pid),'/T','/F'],{stdio:'ignore',windowsHide:true})
      stop.once('exit',resolve);stop.once('error',resolve)
    })
  } else browser.kill()
  const cleanupPath=path.resolve(profile)
  if(path.dirname(cleanupPath)!==path.resolve(tmpdir()) || !path.basename(cleanupPath).startsWith('perler-chart-import-'))throw new Error('Unexpected profile cleanup path')
  try{rmSync(cleanupPath,{recursive:true,force:true,maxRetries:4,retryDelay:300})}catch{/* Browser teardown lock. */}
}
