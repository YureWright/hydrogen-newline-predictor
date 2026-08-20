/**
 * 测算中的进度条：一辆真实氢能重卡贴图（从头图抠出的透明背景 PNG）沿虚线路面往右开，
 * 位置由 pct 决定。
 *
 * 为什么不再用 SVG 卡通车：品牌视觉的整台车更有辨识度；透明背景 PNG 在深色路面上直接生效，
 * 不需要另做描线。
 *
 * indeterminate 态（拿不到 %）：卡车原地怠速抖动 + 路面继续流动，比"来回横冲"更像
 * 一个真的在做事的系统，不会让人误以为卡住。
 */

interface Props {
  /** 0~100 的百分比；传 null 代表还没拿到数字，此时进入不确定态 */
  pct: number | null
}

export default function TruckProgress({ pct }: Props) {
  const clamped = pct == null ? null : Math.min(100, Math.max(0, pct))
  // 卡车左边缘位置：pct=0 时贴左、pct=100 时贴右，为卡车本身宽度留 12% 余量
  const left = clamped == null ? 6 : Math.min(88, Math.max(0, clamped * 0.88))

  return (
    <div className={'truck-prog' + (clamped == null ? ' indet' : '')} aria-hidden="true">
      <div className="truck-prog-road">
        {/* 虚线中央标线：CSS 平移形成"路面往后退"错觉，让静止的卡车看起来在跑 */}
        <div className="truck-prog-lane" />
      </div>
      {/* 已走过的路：一道渐变光带，从起点填到卡车后部 */}
      <div className="truck-prog-trail" style={{ width: `calc(${left}% + 24px)` }} />
      <div className="truck-prog-truck" style={{ left: `${left}%` }}>
        <img src="/truck-cutout.png" alt="" />
        {/* 头灯锥光：位置对齐车头右侧 */}
        <span className="truck-prog-beam" />
      </div>
    </div>
  )
}
