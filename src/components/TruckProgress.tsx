/**
 * 测算中的进度条：一辆卡车沿着虚线路面往右开，位置由 pct 决定。
 *
 * 为什么不用原来的填充条 + shimmer：
 *   一是"卡车在跑"跟品牌视觉直接呼应，路演时比抽象色条更有戏；
 *   二是分不确定进度（pct=null）时，让卡车原地颤动 + 路面流动，比"来回跳的条"更像
 *   一个真的在做事的系统，不会像 indeterminate 那样让人怀疑"是不是卡住了"。
 */

interface Props {
  /** 0~100 的百分比；传 null 代表还没拿到数字，此时进入不确定态 */
  pct: number | null
}

export default function TruckProgress({ pct }: Props) {
  const clamped = pct == null ? null : Math.min(100, Math.max(0, pct))
  // 卡车左边缘位置：pct=0 时贴左、pct=100 时贴右，为卡车本身宽度留 8% 余量
  const left = clamped == null ? 8 : Math.min(92, Math.max(0, clamped * 0.92))

  return (
    <div className={'truck-prog' + (clamped == null ? ' indet' : '')} aria-hidden="true">
      <div className="truck-prog-road">
        {/* 虚线中央标线：靠 CSS 平移形成"路面往后退"错觉，让静止的卡车看起来在跑 */}
        <div className="truck-prog-lane" />
      </div>
      {/* 已走过的路：一道渐变光带，从起点填到卡车后部 */}
      <div className="truck-prog-trail" style={{ width: `calc(${left}% + 12px)` }} />
      <div className="truck-prog-truck" style={{ left: `${left}%` }}>
        {/* 用 SVG 画一辆侧视卡车轮廓，配色跟主题走。为什么不裁头图那张车：
            那张是 3/4 角度俯视，塞到 20px 高的进度条里会糊成一团；侧视线稿在小尺寸更清晰。 */}
        <svg viewBox="0 0 88 32" width="72" height="26" aria-hidden="true">
          <defs>
            <linearGradient id="tp-body" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#e9edf7" />
              <stop offset="55%" stopColor="#9aa6c0" />
              <stop offset="100%" stopColor="#4d5570" />
            </linearGradient>
          </defs>
          {/* 挂车厢体 */}
          <path d="M4 8 L52 8 L52 24 L4 24 Z" fill="url(#tp-body)" stroke="#04060c" strokeWidth="1" />
          {/* 驾驶室（尖头 Tesla Semi 感） */}
          <path d="M52 10 L74 10 L82 16 L82 24 L52 24 Z" fill="url(#tp-body)" stroke="#04060c" strokeWidth="1" />
          {/* 挡风玻璃 */}
          <path d="M56 12 L72 12 L78 16 L56 16 Z" fill="#3ae3ff" opacity="0.85" />
          {/* 头灯 */}
          <circle cx="80" cy="19" r="1.6" fill="#3ae3ff">
            <animate attributeName="opacity" values="1;0.4;1" dur="1.6s" repeatCount="indefinite" />
          </circle>
          {/* 车轮 */}
          <circle cx="16" cy="26" r="3.4" fill="#04060c" stroke="#7d8aa8" strokeWidth="1" />
          <circle cx="34" cy="26" r="3.4" fill="#04060c" stroke="#7d8aa8" strokeWidth="1" />
          <circle cx="70" cy="26" r="3.4" fill="#04060c" stroke="#7d8aa8" strokeWidth="1" />
        </svg>
        {/* 头灯锥光：仅在正常进度时可见，遇到 indet 状态压暗 */}
        <span className="truck-prog-beam" />
      </div>
    </div>
  )
}
