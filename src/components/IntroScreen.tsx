import { useEffect, useState } from 'react'

interface Props {
  onEnter: () => void
}

/**
 * 首屏引导动画：一辆抠好透明背景的氢能重卡从画面深处（透视马路的消失点）驶入，
 * 由远及近逐步放大 + 下移到画面中前景，短暂停留后向右加速驶出，主 App 淡入接管。
 *
 * 三段式状态机（对应 CSS：intro-approach / intro-hold / intro-leave）：
 *   approach（0 → 1500ms）  车从消失点驶来，同时透视马路的白色虚线以更快节奏后退，
 *                          用"路面比车动得更凶"的相对运动感来欺骗大脑：车真的在开
 *   hold    (1500 → 2200ms) 稳定停位；不加大字，只用一个极小的"点击进入或等待"提示
 *   leave   (2200 → 3200ms) 车整体 translateX 到 130vw 加速冲出屏幕右侧，覆盖层同步淡出
 *
 * 用户可以点击画面或右上角"跳过"提前放行；同一浏览器会话只会看一次。
 */
export default function IntroScreen({ onEnter }: Props) {
  const [stage, setStage] = useState<'approach' | 'hold' | 'leave'>('approach')

  useEffect(() => {
    // 进入 → 稳定 → 驶出 三段时序，全部用 setTimeout 排队。
    // 组件卸载时清理，防止 leave 完成前用户点跳过导致 setState on unmounted 报警。
    const t1 = setTimeout(() => setStage('hold'), 1500)
    const t2 = setTimeout(() => setStage('leave'), 2200)
    const t3 = setTimeout(onEnter, 3200)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [onEnter])

  const skip = () => {
    setStage('leave')
    setTimeout(onEnter, 350)
  }

  return (
    <div className={'intro intro-' + stage} onClick={skip} role="dialog" aria-label="欢迎">
      {/* 深空背景 + 星点噪声：图层顺序底 → 顶 */}
      <div className="intro-sky" aria-hidden="true" />
      <div className="intro-stars" aria-hidden="true" />

      {/* 透视马路：一个铺满宽度的矩形，用 rotateX 打成斜面；里面的虚线通过背景平移营造"路面往后飞"的错觉。
          相机视角落在画面 55% 高度附近，与卡车着地点匹配 */}
      <div className="intro-road" aria-hidden="true">
        <div className="intro-road-lanes" />
      </div>
      {/* 地平线一道细青光，衔接天空和路面，也是"远处光源" */}
      <div className="intro-horizon" aria-hidden="true" />

      {/* 卡车贴图：绝对定位在消失点。CSS 变量 --tx/--ty/--tscale 通过 stage 切换驱动缓动 */}
      <div className="intro-truck" aria-hidden="true">
        <img src="/truck-cutout.png" alt="" />
      </div>

      {/* 右上角极简跳过提示：整屏点击也能跳过，此处只是文字提示 */}
      <button
        className="intro-skip"
        onClick={(e) => { e.stopPropagation(); skip() }}
        aria-label="跳过引导"
      >跳过 →</button>
    </div>
  )
}
