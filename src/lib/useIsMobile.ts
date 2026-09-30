import { useEffect, useState } from 'react'

/**
 * 是否是窄屏（手机）。
 *
 * 用 matchMedia 而不是监听 resize：语义更明确，而且只在跨过断点时触发一次，
 * 拖窗口不会疯狂重渲染。React 18 的 useSyncExternalStore 也能做，
 * 但这里只是一个布尔值，手写更直观。
 */
export function useIsMobile(maxWidth = 720): boolean {
  const query = `(max-width: ${maxWidth}px)`
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(query)
    const onChange = () => setIsMobile(mq.matches)
    onChange()
    // 老 Safari 只有 addListener
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    mq.addListener(onChange)
    return () => mq.removeListener(onChange)
  }, [query])

  return isMobile
}
