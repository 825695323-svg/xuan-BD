import { useId } from 'react'
import wordmark from '../assets/brand/xuen-wordmark.jpeg'
import xuanSymbol from '../assets/brand/xuan-symbol.png'
import appLogo from '../assets/brand/xuen-app-logo.png'

type BrandAssetKind = 'wordmark' | 'xuan' | 'app'

const assets = {
  wordmark: { src: wordmark, width: 745, height: 220, viewBox: '99 75 556 74' },
  xuan: { src: xuanSymbol, width: 1254, height: 1254, viewBox: '256 243 742 742' },
  // App 图标 = 主人提供的白底四芒风车稿（已裁切至方块）；双层亮度蒙版：
  // 亮区=方块底（--brand-background），反相亮区=风车纹（--brand-foreground），
  // 暗色主题即原稿（白底黑纹），浅色主题经变量自动反转（黑底白纹）
  app: { src: appLogo, width: 712, height: 693, viewBox: '0 0 712 693' },
}

/** Present the supplied artwork without redrawing it or changing its source files.
 * Viewports omit reference labels; luminance masks remove the surrounding backdrop.
 * The parent link/label supplies the accessible name for these decorative assets.
 */
export default function BrandAsset({ kind, size }: { kind: BrandAssetKind; size?: number }) {
  const id = useId()
  const asset = assets[kind]
  // App 图标：双层蒙版合成（底块 + 反相纹样），颜色随明暗主题变量反转
  if (kind === 'app') {
    const { width, height } = asset
    return <svg className="brand-asset brand-asset--app" width={size} height={size} viewBox={asset.viewBox} aria-hidden="true" focusable="false">
      <defs>
        <filter id={`${id}-invert`} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="-1 0 0 0 1  0 -1 0 0 1  0 0 -1 0 1  0 0 0 1 0" />
        </filter>
        <mask id={`${id}-tile`} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height} style={{ maskType: 'luminance' }}>
          <image href={asset.src} width={width} height={height} />
        </mask>
        <mask id={`${id}-glyph`} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height} style={{ maskType: 'luminance' }}>
          <g filter={`url(#${id}-invert)`}><image href={asset.src} width={width} height={height} /></g>
        </mask>
        <clipPath id={`${id}-clip`}><rect width={width} height={height} /></clipPath>
      </defs>
      <rect width={width} height={height} mask={`url(#${id}-tile)`} className="brand-symbol-background" />
      <g clipPath={`url(#${id}-clip)`}>
        <rect width={width} height={height} mask={`url(#${id}-glyph)`} className="brand-symbol-foreground" />
      </g>
    </svg>
  }
  return <svg className={`brand-asset brand-asset--${kind}`} width={size} height={size} viewBox={asset.viewBox} aria-hidden="true" focusable="false">
    <defs>
      <mask id={`${id}-art`} maskUnits="userSpaceOnUse" x="0" y="0" width={asset.width} height={asset.height} style={{ maskType: 'luminance' }}>
        <image href={asset.src} width={asset.width} height={asset.height} />
      </mask>
    </defs>
    {/* 独立 Xuan Symbol：无边框底，符号经 .brand-asset--xuan 按主题 --brand-symbol 着色 */}
    <rect width={asset.width} height={asset.height} mask={`url(#${id}-art)`} className="brand-symbol-foreground" />
  </svg>
}
