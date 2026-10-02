import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './desktop-theme.css'

const el = document.getElementById('root')
if (!el) throw new Error('#root not found')

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/**
 * 注册离线 service worker。
 *
 * 只在生产构建里注册 —— 开发时挂一个缓存 SW 会让人怀疑人生（改了代码页面不变）。
 * 装好之后整个 app（含图标和示例图纸）都在缓存里，飞机上也能用。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL || '/'
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .catch((e) => console.warn('service worker 注册失败：', e))
  })
}
