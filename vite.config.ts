import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * 部署在子路径下时（GitHub Pages 是 /perler-assistant/）必须设 base，
 * 否则 index.html 里引的 /assets/xxx.js 会指向域名根目录而 404。
 * 本地开发和 preview 用默认的 '/'，互不影响：
 *   BASE_PATH=/perler-assistant/ npm run build
 */
const BASE = process.env.BASE_PATH || '/'

/**
 * 生成离线用的 service worker。
 *
 * 为什么不用 vite-plugin-pwa：这个 app 是单页 + 二十来个静态资源，
 * 自己生成预缓存清单只要几十行，能少掉一整串 workbox 依赖；
 * 而且离线行为可以在本机用 CDP 直接测（tools/offline.mjs）。
 *
 * 为什么要预缓存全部资源：真正的使用场景是「去拼豆时不带电脑」——
 * 在家 WiFi 下打开一次，之后在桌边（甚至飞行模式）完全离线可用。
 */
function offlineSw(base: string): Plugin {
  return {
    name: 'perler-offline-sw',
    apply: 'build',
    closeBundle() {
      const outDir = 'dist'
      const files: string[] = []
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (!entry.name.startsWith('.') && entry.name !== 'sw.js') files.push(full)
        }
      }
      walk(outDir)

      const urls = files.map((f) => base + relative(outDir, f).split(sep).join('/'))
      // 版本号取 index.html 的哈希：产物一变缓存名就变，activate 时清掉旧的
      const version = createHash('sha256')
        .update(readFileSync(join(outDir, 'index.html')))
        .digest('hex')
        .slice(0, 10)

      const total = files.reduce((n, f) => n + statSync(f).size, 0)
      const sw = `/* 由 vite.config.ts 的 offlineSw 插件生成，请勿手改 */
const CACHE = 'perler-${version}'
const INDEX = ${JSON.stringify(base + 'index.html')}
const ASSETS = ${JSON.stringify(urls, null, 2)}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // 逐个 add：个别文件缺失不该让整次安装失败
      await Promise.all(
        ASSETS.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // 导航（打开页面）：先走网络拿新版；断网时回落到缓存的 index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req)
        } catch {
          const cache = await caches.open(CACHE)
          const hit =
            (await cache.match(INDEX)) ||
            (await cache.match(INDEX.replace(/index\\.html$/, '')))
          return hit || Response.error()
        }
      })(),
    )
    return
  }

  // 其它资源：缓存优先（离线也拿得到），未命中再联网并顺手补进缓存
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const hit = await cache.match(req)
      if (hit) return hit
      try {
        const res = await fetch(req)
        if (res.ok && res.type === 'basic') cache.put(req, res.clone())
        return res
      } catch {
        return Response.error()
      }
    })(),
  )
})
`
      writeFileSync(join(outDir, 'sw.js'), sw)
      const mb = (total / 1024 / 1024).toFixed(2)
      console.log(`\n  offline sw: 预缓存 ${urls.length} 个文件（${mb} MB），版本 ${version}`)
    },
  }
}

export default defineConfig({
  base: BASE,
  plugins: [react(), offlineSw(BASE)],
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: false,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
})
