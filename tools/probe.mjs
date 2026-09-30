/**
 * 剖面探针：把某张图纸的「脊覆盖率剖面」和自相关峰值打出来，
 * 用来判断网格识别为什么失败（格距锁错、格线太淡、被格内文字带偏）。
 *
 *   node tools/probe.mjs [示例名] [--margin 2,4,8]
 *
 * 逻辑与 src/lib/gridDetect.ts 保持一致，只是把 margin 参数化以便对比。
 * 在打开的页面里直接跑（同源，能 fetch /samples/*）。
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
const PORT = 9800 + Math.floor(Math.random() * 150)
const file = process.argv[2] ?? 'user.jpg'
const marginArg = process.argv.indexOf('--margin')
const margins =
  marginArg >= 0 && process.argv[marginArg + 1]
    ? process.argv[marginArg + 1].split(',').map(Number)
    : [2, 4, 8, 14]

function killTree(pid) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  } catch {
    /* ignore */
  }
}

const PROBE = `(async () => {
  const FILE = ${JSON.stringify(file)};
  const MARGINS = ${JSON.stringify(margins)};
  const img = new Image();
  img.src = '/samples/' + FILE;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  const MIN_RUN = 3;
  // 与 gridDetect 一致：竖线用左右邻居沿 y 统计，横线用上下邻居沿 x 统计
  function runProfiles(margin, d) {
    const col = new Float64Array(W), row = new Float64Array(H);
    const spanX = Math.max(1, W - 2 * d), spanY = Math.max(1, H - 2 * d);
    const isRidge = (c, na, nb) => Math.abs(c - na) > margin && Math.abs(c - nb) > margin;
    for (let x = d; x < W - d; x++) {
      let counted = 0, run = 0;
      for (let y = d; y < H - d; y++) {
        const i = y * W + x;
        if (isRidge(lum[i], lum[i - d], lum[i + d])) run++;
        else { if (run >= MIN_RUN) counted += run; run = 0; }
      }
      if (run >= MIN_RUN) counted += run;
      col[x] = counted / spanY;
    }
    for (let y = d; y < H - d; y++) {
      let counted = 0, run = 0;
      const base = y * W;
      for (let x = d; x < W - d; x++) {
        const i = base + x;
        if (isRidge(lum[i], lum[i - d * W], lum[i + d * W])) run++;
        else { if (run >= MIN_RUN) counted += run; run = 0; }
      }
      if (run >= MIN_RUN) counted += run;
      row[y] = counted / spanX;
    }
    return { col, row };
  }

  function autocorr(p) {
    const n = p.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += p[i];
    mean /= n;
    const dd = new Float64Array(n);
    let v0 = 0;
    for (let i = 0; i < n; i++) { dd[i] = p[i] - mean; v0 += dd[i] * dd[i]; }
    const maxLag = Math.min(Math.floor(n / 2), Math.max(64, Math.floor(n / 3)));
    const r = new Float64Array(maxLag + 1);
    if (v0 <= 0) return { r, maxLag, v0 };
    const base = v0 / n;
    for (let lag = 1; lag <= maxLag; lag++) {
      let s = 0;
      const cnt = n - lag;
      for (let i = 0; i < cnt; i++) s += dd[i] * dd[i + lag];
      r[lag] = s / cnt / base;
    }
    return { r, maxLag, v0 };
  }

  function peaks(r, maxLag, k) {
    const out = [];
    for (let lag = 4; lag <= maxLag; lag++) {
      if (r[lag] >= r[lag - 1] && (lag === maxLag || r[lag] >= r[lag + 1])) out.push({ lag, v: +r[lag].toFixed(3) });
    }
    out.sort((a, b) => b.v - a.v);
    return out.slice(0, k);
  }

  // 也统计「最强脊行/列」的位置，用来看格线到底在哪
  function topRows(row, k) {
    const idx = Array.from(row.keys());
    idx.sort((a, b) => row[b] - row[a]);
    return idx.slice(0, k).map((i) => i + ':' + row[i].toFixed(2));
  }

  const report = { file: FILE, size: [W, H], byMargin: [] };
  for (const m of MARGINS) {
    const d = Math.max(1, Math.min(3, Math.floor(Math.min(W, H) / 6)));
    const { col, row } = runProfiles(m, d);
    const c = autocorr(col), rw = autocorr(row);
    const cPeaks = peaks(c.r, c.maxLag, 5);
    const rPeaks = peaks(rw.r, rw.maxLag, 5);
    report.byMargin.push({
      margin: m,
      colMax: +Math.max(...col).toFixed(3),
      rowMax: +Math.max(...row).toFixed(3),
      colPeaks: cPeaks,
      rowPeaks: rPeaks,
      topRows: m === MARGINS[0] ? topRows(row, 26) : undefined,
    });
  }

  // 放大一小块，用来看清单格的排版（色号文字是居中还是占满）
  const CR = ${JSON.stringify(String(process.env.CROP || '420,300,170,170,5'))}.split(',').map(Number);
  const cx = CR[0], cy = CR[1], cw = CR[2], ch = CR[3], z = CR[4] || 5;
  const cc = document.createElement('canvas');
  cc.width = cw * z; cc.height = ch * z;
  const cctx = cc.getContext('2d');
  cctx.imageSmoothingEnabled = false;
  cctx.drawImage(cv, cx, cy, cw, ch, 0, 0, cw * z, ch * z);
  report.crop = cc.toDataURL('image/png');

  // ---- 量真相 ----
  // 1) 图纸自带的红色加粗分区线（每 N 格一条）——可以当尺子
  const redRow = new Int32Array(H), redCol = new Int32Array(W);
  let bg = [0, 0, 0];
  {
    let n = 0, sr = 0, sg = 0, sb = 0;
    for (let x = 0; x < W; x += 2) { const p = x * 4; sr += data[p]; sg += data[p+1]; sb += data[p+2]; n++; }
    bg = [sr / n, sg / n, sb / n];
  }
  for (let y = 0; y < H; y++) {
    let p = y * W * 4;
    for (let x = 0; x < W; x++, p += 4) {
      const r = data[p], g = data[p+1], b = data[p+2];
      if (r > g + 22 && r > b + 22 && r > 120) { redRow[y]++; redCol[x]++; }
    }
  }
  const pickLines = (arr, minV) => {
    const out = [];
    for (let i = 1; i < arr.length - 1; i++) {
      if (arr[i] >= minV && arr[i] >= arr[i-1] && arr[i] > arr[i+1]) out.push(i);
    }
    return out;
  };
  const maxRedRow = Math.max(...redRow), maxRedCol = Math.max(...redCol);
  const rl = pickLines(redRow, maxRedRow * 0.35);
  const cl = pickLines(redCol, maxRedCol * 0.35);
  const gaps = (a) => a.slice(1).map((v, i) => v - a[i]);
  report.redRows = { max: maxRedRow, lines: rl, gaps: gaps(rl) };
  report.redCols = { max: maxRedCol, lines: cl, gaps: gaps(cl) };

  // 2) 图案内容包围盒（与页面背景差异明显的像素）
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    let p = y * W * 4;
    for (let x = 0; x < W; x++, p += 4) {
      const d = Math.abs(data[p] - bg[0]) + Math.abs(data[p+1] - bg[1]) + Math.abs(data[p+2] - bg[2]);
      if (d > 40) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  report.pageBg = bg.map((v) => Math.round(v));
  report.contentBox = { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  // 3) 用题注里的格数反推格距（104×104 就写在这里）
  report.derived = {
    cellW_if_104: +((x1 - x0 + 1) / 104).toFixed(3),
    cellH_if_104: +((y1 - y0 + 1) / 104).toFixed(3),
  };
  // 4) 对一组候选行格距，量「采样纯度」和「上下相邻格的变化率」
  //    正确格距：每格一个真格子，纯度高、变化率正常
  //    格距太大：一格里塞了两个真格子，纯度下降
  //    格距太小：一格只是真格子的一部分，纯度也高，但相邻格大量重复（变化率明显偏低）
  const QBASE = 13.59;
  const testPitches = [27.18, 21.2, 17.0, QBASE, 10.6, 8.5, 6.8, 5.3, 4.24];
  const sampleAt = (qx, qy) => {
    const d2 = 3;
    const nCols = Math.max(1, Math.ceil((W - 20) / qx) + 1);
    const nRows = Math.max(1, Math.ceil((H - 20) / qy) + 1);
    // 用 ±1 像素窗口取主色（简化版 sampleCells）
    const cols2 = [], rows2 = [];
    const readCell = (x0, y0, x1, y1) => {
      const hist = new Map();
      let tot = 0;
      for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y++) {
        for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, Math.round(x1)); x++) {
          const p = (y * W + x) * 4;
          const k = (data[p] >> 3) << 10 | (data[p+1] >> 3) << 5 | (data[p+2] >> 3);
          const cur = hist.get(k) || { n: 0, r: 0, g: 0, b: 0 };
          cur.n++; cur.r += data[p]; cur.g += data[p+1]; cur.b += data[p+2];
          hist.set(k, cur); tot++;
        }
      }
      if (!tot) return null;
      let best = null;
      for (const v of hist.values()) if (!best || v.n > best.n) best = v;
      return { p: best.n / tot, r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };
    };
    const grid = [];
    for (let r = 0; r < nRows; r++) {
      const row = [];
      for (let c = 0; c < nCols; c++) {
        const x0 = 20 + c * qx, y0 = 20 + r * qy;
        const ix = Math.max(1, qx * 0.18), iy = Math.max(1, qy * 0.18);
        row.push(readCell(x0 + ix, y0 + iy, x0 + qx - ix, y0 + qy - iy));
      }
      grid.push(row);
    }
    let sum = 0, n = 0, vSame = 0, vTot = 0;
    for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) {
      const cell = grid[r][c];
      if (cell) { sum += cell.p; n++; }
      if (r > 0) {
        const a = grid[r-1][c], b = grid[r][c];
        if (a && b) {
          vTot++;
          if (Math.abs(a.r-b.r) + Math.abs(a.g-b.g) + Math.abs(a.b-b.b) < 24) vSame++;
        }
      }
    }
    return { purity: +(sum / Math.max(1, n)).toFixed(3), vSameRate: +(vSame / Math.max(1, vTot)).toFixed(3) };
  };
  report.pitchCurve = testPitches.map((q) => ({ q, ...sampleAt(QBASE, q) }));
  return report;
})()`

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
}

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome/Edge')
    process.exit(2)
  }
  const profile = mkdtempSync(path.join(tmpdir(), 'pa-probe-'))
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `${BASE}/`,
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
    await new Promise((r) => setTimeout(r, 1500))

    const rep = await cdp.eval(PROBE)
    console.log(`\n图片：${rep.file}  ${rep.size[0]}×${rep.size[1]}\n`)
    if (rep.crop) {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync('_shots', { recursive: true })
      const b64 = rep.crop.replace(/^data:image\/png;base64,/, '')
      writeFileSync(path.resolve('_shots', 'probe-crop.png'), Buffer.from(b64, 'base64'))
      console.log('放大截图：_shots/probe-crop.png\n')
    }
    for (const m of rep.byMargin) {
      console.log(`── margin = ${m.margin}  剖面峰值 col=${m.colMax} row=${m.rowMax}`)
      console.log(`   列方向自相关峰值： ${m.colPeaks.map((p) => `${p.lag}(${p.v})`).join('  ')}`)
      console.log(`   行方向自相关峰值： ${m.rowPeaks.map((p) => `${p.lag}(${p.v})`).join('  ')}`)
      if (m.topRows) console.log(`   行剖面最强的行：   ${m.topRows.join('  ')}`)
      console.log('')
    }
    if (rep.pageBg) {
      console.log('── 量真相 ──')
      console.log(`页面背景 RGB(${rep.pageBg.join(',')})`)
      console.log(`内容包围盒： x ${rep.contentBox.x0}..${rep.contentBox.x1} (${rep.contentBox.w}px)  y ${rep.contentBox.y0}..${rep.contentBox.y1} (${rep.contentBox.h}px)`)
      console.log(`若格数是 104×104 → 格距 ${rep.derived.cellW_if_104} × ${rep.derived.cellH_if_104} px`)
      console.log(`红色分区线（横向） max=${rep.redRows.max} 位置=${rep.redRows.lines.join(',')}`)
      console.log(`   间距=${rep.redRows.gaps.join(',')}`)
      console.log(`红色分区线（纵向） max=${rep.redCols.max} 位置=${rep.redCols.lines.join(',')}`)
      console.log(`   间距=${rep.redCols.gaps.join(',')}`)
    }
    if (rep.pitchCurve) {
      console.log('\n── 行格距候选的验证（列格距固定 13.59）──')
      console.log('   格距      纯度    上下相邻重复率')
      for (const p of rep.pitchCurve) {
        console.log(`   ${String(p.q).padEnd(8)} ${String(p.purity).padEnd(7)} ${p.vSameRate}`)
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
    await new Promise((r) => setTimeout(r, 500))
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error('探针异常：', e.message)
  process.exit(1)
})
