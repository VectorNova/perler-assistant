// 用 esbuild 打包 tools/verify.ts 并在 Node 中运行
import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 打包产物写到项目内的缓存目录，而不是 os.tmpdir()。
 *
 * 原来用 mkdtempSync(tmpdir()) + esbuild 写文件，会不定期挂在
 * `open %TEMP%\perler-verify-xxxx\verify.mjs: Access is denied`
 * （Temp 目录本身可写、ACL 正常，是临时目录被安全软件/文件锁干扰那类问题）。
 * 项目内的目录一直在被 vite/tsc 正常写入，改到这里更稳。
 * 仍然保留 temp 兜底 + 一次重试。
 */
const candidates = [
  path.resolve('node_modules/.cache/perler-verify'),
  path.join(tmpdir(), `perler-verify-${process.pid}`),
]

async function bundleInto(dir) {
  mkdirSync(dir, { recursive: true })
  const outfile = path.join(dir, 'verify.mjs')
  await build({
    entryPoints: [path.resolve('tools/verify.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'warning',
  })
  return outfile
}

let outfile = null
let usedDir = null
let lastErr = null
for (const dir of candidates) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      outfile = await bundleInto(dir)
      usedDir = dir
      break
    } catch (e) {
      lastErr = e
      console.warn(`esbuild 输出到 ${dir} 失败（第 ${attempt} 次）：${e.message?.split('\n')[0]}`)
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  if (outfile) break
}

if (!outfile) {
  console.error('打包 verify.ts 失败：', lastErr?.message ?? lastErr)
  process.exit(1)
}

try {
  await import(pathToFileURL(outfile).href)
} finally {
  // 只删掉这次的产物，保留缓存目录本身
  try {
    if (usedDir) rmSync(outfile, { force: true })
  } catch {
    /* ignore */
  }
  if (usedDir && usedDir.startsWith(tmpdir())) {
    try {
      rmSync(usedDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}
