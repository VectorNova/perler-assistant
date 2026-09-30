/**
 * 静态资源的 URL。
 *
 * 部署到子路径下时（GitHub Pages 是 `https://<user>.github.io/perler-assistant/`），
 * 写死的 `/logo-96.png` 会指向域名根目录，全部 404。
 * 统一用 Vite 注入的 `BASE_URL` 拼，本地开发（base = `/`）行为不变。
 *
 * 例：base = `/perler-assistant/` 时 assetUrl('samples/a.png') → `/perler-assistant/samples/a.png`
 */
export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/'
  const withSlash = base.endsWith('/') ? base : `${base}/`
  return withSlash + path.replace(/^\/+/, '')
}
