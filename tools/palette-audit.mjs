/**
 * 调色板近色审计：找出「彼此色差极小、从照片上根本分不开」的颜色。
 *
 *   node tools/palette-audit.mjs
 *
 * 为什么需要这个：逐格采样必然带噪声（格内色号文字、格线、JPEG 压缩）。
 * 如果两个色号本身 ΔE 只有 1~2，那噪声稍微一抖就会让格子落到另一个色号上 ——
 * 表现就是「识别出了图纸上根本没有的颜色」。这个脚本把这类「雷区」量化出来，
 * 用来判断某个误识别到底是算法问题还是色板本身不可分。
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = path.resolve('node_modules/.cache/perler-audit')
mkdirSync(dir, { recursive: true })
const outfile = path.join(dir, 'color.mjs')
await build({
  entryPoints: [path.resolve('src/lib/color.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'warning',
})
const { PALETTE, deltaE2000 } = await import(pathToFileURL(outfile).href)
rmSync(outfile, { force: true })

/** 阈值：ΔE < 这个值，从照片上基本无法区分 */
const TIGHT = 2.5
/** 更深一档：连原始矢量图都容易被搞混 */
const VERY_TIGHT = 1.5

const n = PALETTE.length
console.log(`调色板共 ${n} 色\n`)

// 两两算距离，记录「每个颜色的最近邻」
const nn = new Array(n).fill(null).map(() => ({ d: Infinity, i: -1 }))
const pairs = []
for (let i = 0; i < n; i++) {
  for (let j = i + 1; j < n; j++) {
    const d = deltaE2000(PALETTE[i].lab, PALETTE[j].lab)
    if (d < nn[i].d) nn[i] = { d, i: j }
    if (d < nn[j].d) nn[j] = { d, i }
    if (d < TIGHT) pairs.push({ i, j, d })
  }
}
pairs.sort((a, b) => a.d - b.d)

const hex = (i) => PALETTE[i].hex
const mard = (i) => PALETTE[i].keys.MARD
const manman = (i) => PALETTE[i].keys['漫漫']

console.log(`=== 彼此 ΔE < ${TIGHT} 的颜色对：${pairs.length} 对 ===`)
for (const p of pairs) {
  console.log(
    `  ΔE ${p.d.toFixed(2)}  ${mard(p.i).padEnd(4)} ${hex(p.i)}  ↔  ${mard(p.j).padEnd(4)} ${hex(p.j)}`,
  )
}

// 极紧的对单独列出来
const veryTight = pairs.filter((p) => p.d < VERY_TIGHT)
console.log(`\n其中 ΔE < ${VERY_TIGHT}（几乎完全同色）：${veryTight.length} 对`)

// 没有任何近邻（孤立）的颜色
const lonely = []
for (let i = 0; i < n; i++) if (nn[i].d >= TIGHT) lonely.push(i)
console.log(`\n=== 最近邻都 ≥ ΔE ${TIGHT} 的颜色（不会误判）：${lonely.length} 个 ===`)
console.log(`  （占 ${((lonely.length / n) * 100).toFixed(0)}%）`)

// 近白 / 近灰这类「低饱和高亮度」的颜色最容易翻车，单独统计
const isNearWhite = (i) => {
  const [r, g, b] = PALETTE[i].rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return min > 225 && max - min < 26
}
const whites = []
for (let i = 0; i < n; i++) if (isNearWhite(i)) whites.push(i)
console.log(`\n=== 近白/近纸色（rgb 都 > 225 且饱和度极低）：${whites.length} 个 ===`)
for (const i of whites) {
  const t = nn[i]
  console.log(
    `  ${mard(i).padEnd(4)} ${hex(i)}  最近邻 ${mard(t.i).padEnd(4)} ${hex(t.i)}  ΔE ${t.d.toFixed(2)}`,
  )
}

// 用户报的两个色号
console.log('\n=== 你报的两个色号 ===')
for (const code of ['P01', 'R08']) {
  const i = PALETTE.findIndex((p) => p.keys.MARD === code)
  if (i < 0) {
    console.log(`  ${code} 不在色板里`)
    continue
  }
  // 找所有 ΔE < 3 的邻居
  const near = []
  for (let j = 0; j < n; j++) {
    if (j === i) continue
    const d = deltaE2000(PALETTE[i].lab, PALETTE[j].lab)
    if (d < 3) near.push({ d, j })
  }
  near.sort((a, b) => a.d - b.d)
  console.log(
    `  ${code} = ${hex(i)}  附近 ΔE<3 的还有 ${near.length} 个：` +
      near.map((x) => `${mard(x.j)}(${x.d.toFixed(1)})`).join(' '),
  )
}

console.log('\n=== 判断 ===')
console.log(
  `  ${pairs.length} 对近色意味着：这些格子的识别结果是「掷硬币」的，` +
    `噪声一抖就会换色号 ——\n  这正是「图纸上没有 P1/R8 却出现」的机制之一。`,
)
writeFileSync(
  path.resolve('_shots/palette-audit.txt'),
  pairs.map((p) => `${p.d.toFixed(3)}\t${mard(p.i)}\t${hex(p.i)}\t${mard(p.j)}\t${hex(p.j)}`).join('\n'),
)
console.log('\n  完整清单写入 _shots/palette-audit.txt')
