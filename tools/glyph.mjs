/**
 * 字形提取的调试工具：把格子里的色号文字切出来，渲染成对照表供人工核对。
 *
 *   node tools/glyph.mjs "<图片路径>" [列数] [行数] [每格像素]
 *
 * 为什么先做这个：认字之前必须先确认「切得对、看得清」。
 * 这一版不认字，只输出：
 *   - 自动检测到的网格（含叠加调试图）
 *   - 若干格子的原始裁剪（放大）
 *   - 切出的字符归一化位图（## 文本形式，能直接看出切分对不对）
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
const ROOT = path.resolve('..')
const CDP_PORT = 9900 + Math.floor(Math.random() * 90)

const imgName = path.basename(process.argv[2] ?? '哥伦比亚图纸.png')
const mergeDist = Number(process.env.MERGE ?? 4)
const argCols = Number(process.argv[3] ?? 0)
const argRows = Number(process.argv[4] ?? 0)
const argCell = Number(process.argv[5] ?? 0)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

function startServer(root) {
  const server = createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent((req.url || '/').split('?')[0])
      if (rel === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><meta charset="utf-8"><body>')
        return
      }
      const file = path.join(root, rel)
      if (!file.startsWith(root)) {
        res.writeHead(403).end()
        return
      }
      const s = await stat(file)
      if (!s.isFile()) throw new Error('nope')
      const body = await readFile(file)
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
      })
      res.end(body)
    } catch {
      res.writeHead(404).end('404')
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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails).slice(0, 300))
    }
    return r.result?.value
  }
}

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome')
    process.exit(2)
  }
  const bundled = await build({
    entryPoints: [path.resolve('tools/glyph-entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    logLevel: 'warning',
  })
  const script = bundled.outputFiles[0].text

  const { server, port } = await startServer(ROOT)
  const url = `http://127.0.0.1:${port}/`
  console.log(`图片: ${imgName}   手工参数: 列=${argCols || '自动'} 行=${argRows || '自动'} 格=${argCell || '自动'}\n`)

  const profile = mkdtempSync(path.join(tmpdir(), 'pa-glyph-'))
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
    await sleep(400)
    await cdp.eval(script)
    if (!(await cdp.eval(`!!window.__glyph`))) throw new Error('bundle 注入失败')

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

      // 1) 网格：优先用命令行给的，否则自动检测
      let grid;
      let how;
      const argCols = ${argCols}, argRows = ${argRows}, argCell = ${argCell};
      if (argCols > 0 && argCell > 0) {
        const det = window.__glyph.detectGrid(data);
        // 用自动检测的原点，手工的格距/格数
        grid = { offsetX: det.grid.offsetX, offsetY: det.grid.offsetY, cellW: argCell, cellH: argCell,
                 cols: argCols, rows: argRows || argCols };
        how = '手工格距';
      } else {
        const det = window.__glyph.detectGrid(data);
        grid = det.grid;
        how = '自动 (置信度 ' + Math.round(det.confidence * 100) + '%)';
      }

      // 2) 抽样若干格子看字形
      const n = 14;
      const samples = [];
      const stepR = Math.max(1, Math.floor(grid.rows / 4));
      const stepC = Math.max(1, Math.floor(grid.cols / 4));
      const picked = [];
      for (let r = Math.floor(stepR/2); r < grid.rows && picked.length < n; r += stepR) {
        for (let cc = Math.floor(stepC/2); cc < grid.cols && picked.length < n; cc += stepC) {
          picked.push({ col: cc, row: r });
        }
      }
      const res = window.__glyph.extractGlyphs(data, grid, {
        limit: { col: picked[0].col, row: picked[0].row, cols: 1, rows: 1 },
      });
      for (const p of picked) {
        const one = window.__glyph.extractGlyphs(data, grid, { limit: { col: p.col, row: p.row, cols: 1, rows: 1 } });
        const cell = one.cells[0];
        if (!cell) continue;
        samples.push({
          col: p.col, row: p.row,
          fill: window.__glyph.fillHex(cell),
          inkRatio: Number(cell.inkRatio.toFixed(3)),
          nChars: cell.chars.length,
          texts: window.__glyph.maskToText(cell),
        });
      }

      // 3) 全图统计
      const all = window.__glyph.extractGlyphs(data, grid);
      const charCount = {};
      for (const cell of all.cells) {
        const k = cell.chars.length;
        charCount[k] = (charCount[k] ?? 0) + 1;
      }

      // 3b) 聚类（只保留有文字的格子）
      const cells = all.cells.filter((c) => c.chars.length > 0);
      const tClu = performance.now();
      const cluster = window.__glyph.clusterChars(cells, );
      const msCluster = performance.now() - tClu;

      let searchInfo = "";
      // 3c) 按颜色组约束求解：同色同码（实测 100% 成立），组数远小于格数，候选可以放宽
      const tLab = performance.now();
      const pool = window.__glyph.indicesInSystem('MARD221');
      const scoredPool = pool.map((i) => ({ i, code: window.__glyph.codeOf(i, 'MARD') }));
      const byFill = new Map();
      cluster.refs.forEach((r, idx) => {
        const cell = cells[r.cell];
        const key = window.__glyph.fillHex(cell);
        let g = byFill.get(key);
        if (!g) { g = { fill: key, rgb: cell.fill, seqs: new Map() }; byFill.set(key, g); }
        if (!g.seqs.has(r.cell)) g.seqs.set(r.cell, []);
        g.seqs.get(r.cell)[r.pos] = cluster.assign[idx];
      });
      const groups = [];
      let sameSeqGroups = 0;
      for (const g of byFill.values()) {
        const tally = new Map();
        for (const seq of g.seqs.values()) {
          const k = seq.join(',');
          tally.set(k, (tally.get(k) ?? 0) + 1);
        }
        if (tally.size === 1) sameSeqGroups++;
        let best = '', bestN = -1;
        for (const [k, n] of tally) if (n > bestN) { bestN = n; best = k; }
        const seq = best === '' ? [] : best.split(',').map(Number);
        const cands = scoredPool
          .filter((s) => s.code.length === seq.length)
          .map((s) => {
            const p = window.__glyph.PALETTE[s.i];
            const d = Math.sqrt(
              (g.rgb[0] - p.rgb[0]) ** 2 + (g.rgb[1] - p.rgb[1]) ** 2 + (g.rgb[2] - p.rgb[2]) ** 2
            );
            return { code: s.code, d };
          })
          .sort((a, b) => a.d - b.d)
          .map((s) => s.code);
        groups.push({ fill: g.fill, n: g.seqs.size, seq, candidates: cands, top: cands[0] ?? '?', rgb: g.rgb });
      }
      const vocab = pool.map((i) => window.__glyph.codeOf(i, 'MARD'));
      // 代价函数：该组填色 与 候选色号在色板里的颜色 的 RGB 欧氏距离。
      // 颜色当**弱先验**用（不能当硬约束 —— 实测这批图纸的填色和公开色板中位差 12.6）。
      const codeRgb = new Map();
      pool.forEach((i) => {
        const p = window.__glyph.PALETTE[i];
        codeRgb.set(window.__glyph.codeOf(i, 'MARD'), p.rgb);
      });
      const label = window.__glyph.solveGroups(groups, cluster.classes.length, {
        vocab,
        prefer: groups.map((g) => g.top),
        cost: (gi, code) => {
          const rgb = codeRgb.get(code);
          if (!rgb) return 1000;
          const f = groups[gi].rgb;
          return Math.sqrt((f[0]-rgb[0])**2 + (f[1]-rgb[1])**2 + (f[2]-rgb[2])**2);
        },
        maxNodes: 400000,
      });
      searchInfo = "约束搜索：访问 " + label.nodes + " 个节点，找到 " + label.solutions + " 个可行解";
      const msLabel = performance.now() - tLab;

      // 5) 自检：同一填色的格子是否都被读成同一个色号
      const groupCode = new Map();
      groups.forEach((g, i) => groupCode.set(g.fill, label.codeOfGroup[i]));
      const byFillCheck = {};
      cells.forEach((c) => {
        const k = window.__glyph.fillHex(c);
        if (!byFillCheck[k]) byFillCheck[k] = { n: 0, codes: {} };
        byFillCheck[k].n++;
        const code = groupCode.has(k) ? groupCode.get(k) : null;
        const key = code === null ? '(未读出)' : code;
        byFillCheck[k].codes[key] = (byFillCheck[k].codes[key] ?? 0) + 1;
      });
      const fillSummary = Object.entries(byFillCheck)
        .map(([fill, v]) => {
          const top = Object.entries(v.codes).sort((a, b) => b[1] - a[1]);
          return { fill, n: v.n, distinct: top.length, top: top[0][0], topN: top[0][1], all: top.slice(0, 4) };
        })
        .sort((a, b) => b.n - a.n);

      // 4) 调试图：网格叠加 + 抽样格子的放大裁剪
      const c1 = document.createElement('canvas');
      c1.width = W; c1.height = H;
      const g1 = c1.getContext('2d');
      g1.drawImage(img, 0, 0);
      g1.strokeStyle = 'rgba(255,0,0,0.55)';
      g1.lineWidth = 1;
      for (let i = 0; i <= grid.cols; i++) {
        const x = grid.offsetX + i * grid.cellW;
        g1.beginPath(); g1.moveTo(x, grid.offsetY); g1.lineTo(x, grid.offsetY + grid.rows * grid.cellH); g1.stroke();
      }
      for (let j = 0; j <= grid.rows; j++) {
        const y = grid.offsetY + j * grid.cellH;
        g1.beginPath(); g1.moveTo(grid.offsetX, y); g1.lineTo(grid.offsetX + grid.cols * grid.cellW, y); g1.stroke();
      }
      try { g1.drawImage(c1, 0, 0); } catch (e) {}

      // 抽样格子的放大对照（每格裁出来按 zoom 放大，横排）
      const zoom = Math.max(2, Math.min(8, Math.floor(1400 / (Math.max(1, picked.length) * grid.cellW))));
      const cw = Math.round(grid.cellW), chh = Math.round(grid.cellH);
      const sheet = document.createElement('canvas');
      sheet.width = Math.round(cw * zoom) * Math.min(picked.length, 7);
      sheet.height = Math.round(chh * zoom) * Math.ceil(picked.length / 7);
      const gs = sheet.getContext('2d');
      gs.imageSmoothingEnabled = false;
      gs.fillStyle = '#222'; gs.fillRect(0, 0, sheet.width, sheet.height);
      picked.forEach((p, i) => {
        const px = Math.round(grid.offsetX + p.col * grid.cellW);
        const py = Math.round(grid.offsetY + p.row * grid.cellH);
        gs.drawImage(img, px, py, cw, chh, (i % 7) * cw * zoom, Math.floor(i / 7) * chh * zoom, cw * zoom, chh * zoom);
      });

      return {
        W, H, how, grid: { cols: grid.cols, rows: grid.rows, cellW: Number(grid.cellW.toFixed(2)),
                           cellH: Number(grid.cellH.toFixed(2)), offsetX: Number(grid.offsetX.toFixed(1)),
                           offsetY: Number(grid.offsetY.toFixed(1)) },
        samples, charCount,
        withText: all.withText, totalChars: all.totalChars, cells: all.cells.length,
        msCluster: Math.round(msCluster), msLabel: Math.round(msLabel),
        classes: cluster.classes.map((c) => ({ id: c.id, count: c.count, text: window.__glyph.classToText(c.bits) })),
        charOf: label.charOf,
        stats: label.stats,
        sameSeqGroups,
        groups: groups.map((g, i) => ({ fill: g.fill, n: g.n, top: g.top, code: label.codeOfGroup[i], compat: label.compatibleCount[i], seq: g.seq.join('-') })),
        fillSummary,
        sheet: sheet.toDataURL('image/png'),
      };
    })()`)

    console.log(`图片 ${out.W}×${out.H}`)
    console.log(`网格（${out.how}）：${out.grid.cols} 列 × ${out.grid.rows} 行  ` +
      `格距 ${out.grid.cellW} × ${out.grid.cellH}  原点 ${out.grid.offsetX},${out.grid.offsetY}`)
    console.log(`格子总数 ${out.cells}   有文字 ${out.withText}   切出字符 ${out.totalChars}`)
    console.log(`每格字符数分布：${JSON.stringify(out.charCount)}`)

    console.log(`\n=== 聚类 ===`)
    console.log(`字形类 ${out.classes.length} 个（耗时 ${out.msCluster}ms）`)
    console.log(`贴标签 ${out.msLabel}ms`)
    console.log(`统计：类 ${out.stats.classes} 个，解出 ${out.stats.labeledClasses} 个；` +
      `格子 ${out.stats.cellsTotal}，读出 ${out.stats.cellsRead}` +
      `（${((out.stats.cellsRead / Math.max(1, out.stats.cellsTotal)) * 100).toFixed(1)}%）；` +
      `与颜色先验不一致 ${out.stats.disagreedWithColor}；矛盾 ${out.stats.conflicted}`)

    console.log(`\n=== 按颜色组求解 ===`)
    console.log(`颜色组 ${out.stats.groups} 个：解出 ${out.stats.groupsResolved} 个，` +
      `覆盖 ${out.stats.cellsCovered}/${out.stats.cellsTotal} 格 ` +
      `(${((out.stats.cellsCovered / Math.max(1, out.stats.cellsTotal)) * 100).toFixed(1)}%)；` +
      `候选全不相容 ${out.stats.deadEnds} 组`)
    console.log(`「同色同码」自检：${out.sameSeqGroups}/${out.stats.groups} 个颜色组的字形序列完全一致`)
    console.log(`\n  颜色组明细（按格数排序，前 30）`)
    console.log(`  格数   序列          颜色先验前3      读出色号`)
    for (const g of out.groups.slice().sort((a, b) => b.n - a.n)) {
      const mark = g.code ? (g.code === g.top ? ' ' : '*') : '?'
      console.log(`  ${String(g.n).padStart(5)}  ${String(g.seq).padEnd(12)}  ${String(g.top).padEnd(14)}  ${String(g.code ?? '未读出')}`)
    }
    console.log(`\n=== 解出的字符表（类号 → 字符）===`)
    console.log('  ' + out.charOf.map((c, i) => `${i}:${c ?? '?'}`).join('  '))

    console.log(`\n=== 字形类（按出现次数排序，前 24 个）===`)
    const showN = 24
    const cols = 6
    for (let row = 0; row < Math.ceil(Math.min(showN, out.classes.length) / cols); row++) {
      const slice = out.classes.slice(row * cols, row * cols + cols)
      console.log('   ' + slice.map((c) => `#${String(c.id).padStart(2)} x${String(c.count).padEnd(5)}  ${c.text[0]}`).join(' | '))
      for (let y = 1; y < slice[0].text.length; y++) {
        console.log('   ' + slice.map((c) => `         ${c.text[y]} `).join(' | '))
      }
      console.log('')
    }

    console.log(`=== 自检：同一填色是否读成同一色号（前 16 种填色）===`)
    let consistent = 0
    let inconsistent = 0
    for (const f of out.fillSummary) {
      const ok = f.distinct === 1
      if (ok) consistent++
      else inconsistent++
    }
    console.log(`  填色种类 ${out.fillSummary.length}：一致的 ${consistent}，不一致的 ${inconsistent}`)
    for (const f of out.fillSummary.slice(0, 16)) {
      const mark = f.distinct === 1 ? '✓' : '✗'
      console.log(`  ${mark} ${f.fill} ×${String(f.n).padEnd(5)} → ${f.all.map(([c, n]) => `${c}×${n}`).join('  ')}`)
    }
    for (const s of out.samples) {
      console.log(`\n  [${s.col},${s.row}]  填色 ${s.fill}  墨占比 ${s.inkRatio}  切出 ${s.nChars} 字`)
      if (s.texts.length === 0) {
        console.log('    （没有文字）')
        continue
      }
      // 横向并排显示
      const lines = s.texts[0].split('\n')
      for (let i = 0; i < lines.length; i++) {
        console.log('    ' + s.texts.map((t) => t.split('\n')[i] ?? ' '.repeat(10)).join('  '))
      }
    }

    mkdirSync(SHOTS, { recursive: true })
    writeFileSync(path.join(SHOTS, `glyph-${imgName.replace(/\.[^.]+$/, '')}-sheet.png`),
      Buffer.from(out.sheet.split(',')[1], 'base64'))
    console.log(`\n对照表：_shots/glyph-${imgName.replace(/\.[^.]+$/, '')}-sheet.png`)
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
    await sleep(300)
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
