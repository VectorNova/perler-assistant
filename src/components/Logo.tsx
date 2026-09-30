interface Props {
  /** 图标边长（px） */
  size?: number
  /** 是否显示「拼豆辅助」文字 */
  showText?: boolean
  text?: string
}

/**
 * 品牌标识：logo 图标 + 渐变文字。
 *
 * 图标是 tools/make-icons.ps1 从原图裁掉透明留白后生成的，
 * 白底、内容和顶栏同色，所以在界面上看起来就是一枚透明的标记。
 * 用 <img> 而不是内联 SVG：原图是位图，内联没有好处还会让 JS 变大。
 */
export default function Logo({ size = 26, showText = true, text = '拼豆辅助' }: Props) {
  return (
    <span className="logo">
      <img className="logo-mark" src="/logo-96.png" alt="" width={size} height={size} />
      {showText && <span className="logo-text">{text}</span>}
    </span>
  )
}
