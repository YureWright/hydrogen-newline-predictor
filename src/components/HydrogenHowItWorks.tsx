/** 氢能消耗预测 · 技术原理（论文级：LaTeX 公式 + SVG 配图 + 数据/处理/模型/预测全流程，全部实测不造假） */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/** KaTeX 公式渲染（块级/行内） */
function Tex({ math, block = false }: { math: string; block?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const katex = (window as any).katex
    if (ref.current && katex) katex.render(math, ref.current, { throwOnError: false, displayMode: block })
  }, [math, block])
  return <span ref={ref} className={block ? 'tex-block' : 'tex-inline'} />
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <div className="hw-table"><table>
      <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
    </table></div>
  )
}

function Sec({ num, title, children }: { num: string; title: string; children: ReactNode }) {
  return (<section className="hw-sec"><h4><span className="hw-num">{num}</span>{title}</h4>{children}</section>)
}

function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (<div className="hw-sub"><h5>{title}</h5>{children}</div>)
}

/** SVG 数据流总览图（训练路径 / 预测路径） */
function FlowDiagram() {
  const box = { stroke: 'rgba(58,227,255,0.55)', fill: 'rgba(58,227,255,0.08)', rx: 8 }
  const box2 = { stroke: 'rgba(164,115,255,0.55)', fill: 'rgba(164,115,255,0.08)', rx: 8 }
  const arr = { stroke: 'rgba(233,237,247,0.5)', strokeWidth: 1.5, markerEnd: 'url(#hw-arrow)' }
  const t = { fill: '#e9edf7', fontSize: 12, textAnchor: 'middle' as const }
  return (
    <svg viewBox="0 0 820 360" className="hw-svg" role="img" aria-label="数据流总览">
      <defs><marker id="hw-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="rgba(233,237,247,0.6)" /></marker></defs>
      <text x="410" y="18" fill="#3ae3ff" fontSize="13" textAnchor="middle" fontWeight="600">训练路径（离线）</text>
      <rect x="20" y="36" width="150" height="46" {...box} /><text x="95" y="56" {...t}>两车实车数据</text><text x="95" y="72" {...t} fontSize="11" fill="#9aa6c0">60s×5504条</text>
      <rect x="200" y="36" width="150" height="46" {...box} /><text x="275" y="56" {...t}>外部回填</text><text x="275" y="72" {...t} fontSize="11" fill="#9aa6c0">DEM/ERA5/高德</text>
      <rect x="380" y="36" width="170" height="46" {...box} /><text x="465" y="56" {...t}>清洗·统一单位·目标</text><text x="465" y="72" {...t} fontSize="11" fill="#9aa6c0">v→km/h, a=Δv/Δt, ΔH₂</text>
      <rect x="580" y="36" width="170" height="46" {...box} /><text x="665" y="56" {...t}>5km 段聚合</text><text x="665" y="72" {...t} fontSize="11" fill="#9aa6c0">1071 段</text>
      <rect x="240" y="120" width="330" height="50" {...box2} /><text x="405" y="142" {...t}>工况合成 · 特征构造（18 维）</text><text x="405" y="159" {...t} fontSize="11" fill="#c3aaff">片段库拼接 → 深度特征</text>
      <rect x="300" y="196" width="210" height="46" {...box2} /><text x="405" y="216" {...t}>HistGB 训练</text><text x="405" y="232" {...t} fontSize="11" fill="#c3aaff">18特征 → kg/km</text>
      <rect x="320" y="262" width="170" height="40" {...box2} /><text x="405" y="286" {...t}>model.joblib</text>
      <text x="410" y="322" fill="#3ae3ff" fontSize="13" textAnchor="middle" fontWeight="600">预测路径（在线）</text>
      <rect x="20" y="292" width="150" height="52" {...box} /><text x="95" y="312" {...t}>系统分段(SegmentData)</text><text x="95" y="328" {...t} fontSize="11" fill="#9aa6c0">均速/坡度/温度/等级</text>
      <rect x="200" y="292" width="150" height="52" {...box} /><text x="275" y="312" {...t}>工况合成(同训练口径)</text><text x="275" y="328" {...t} fontSize="11" fill="#9aa6c0">模板拼接+对齐+坡度</text>
      <rect x="380" y="292" width="170" height="52" {...box} /><text x="465" y="312" {...t}>18 特征向量</text><text x="465" y="328" {...t} fontSize="11" fill="#9aa6c0">缺失→默认兜底</text>
      <rect x="580" y="292" width="170" height="52" {...box} /><text x="665" y="312" {...t}>预测每段 kg/km</text><text x="665" y="328" {...t} fontSize="11" fill="#9aa6c0">×里程=总氢耗</text>
      <line x1="170" y1="59" x2="200" y2="59" {...arr} />
      <line x1="350" y1="59" x2="380" y2="59" {...arr} />
      <line x1="550" y1="59" x2="580" y2="59" {...arr} />
      <line x1="405" y1="82" x2="405" y2="120" {...arr} />
      <line x1="405" y1="170" x2="405" y2="196" {...arr} />
      <line x1="405" y1="242" x2="405" y2="262" {...arr} />
      <line x1="170" y1="318" x2="200" y2="318" {...arr} />
      <line x1="350" y1="318" x2="380" y2="318" {...arr} />
      <line x1="550" y1="318" x2="580" y2="318" {...arr} />
    </svg>
  )
}

/** SVG 工况合成示意图 */
function SynthDiagram() {
  const t = { fill: '#e9edf7', fontSize: 11, textAnchor: 'middle' as const }
  return (
    <svg viewBox="0 0 820 180" className="hw-svg" role="img" aria-label="工况合成流程">
      <rect x="20" y="20" width="180" height="80" rx="8" fill="rgba(58,227,255,0.08)" stroke="rgba(58,227,255,0.5)" />
      <text x="110" y="40" {...t} fontWeight="600">实车 60s 速度片段库</text>
      <text x="110" y="58" {...t} fontSize="10" fill="#9aa6c0">按 等级×均速 分 8 桶</text>
      <text x="110" y="74" {...t} fontSize="10" fill="#9aa6c0">高速-低速…城市-高速</text>
      <text x="110" y="90" {...t} fontSize="10" fill="#9aa6c0">每桶存真实 v 序列</text>
      <line x1="200" y1="60" x2="240" y2="60" stroke="rgba(233,237,247,0.5)" strokeWidth="1.5" markerEnd="url(#syn-arrow)" />
      <defs><marker id="syn-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="rgba(233,237,247,0.6)" /></marker></defs>
      <rect x="240" y="20" width="170" height="80" rx="8" fill="rgba(164,115,255,0.08)" stroke="rgba(164,115,255,0.5)" />
      <text x="325" y="40" {...t} fontWeight="600">① 随机拼接 v 片段</text>
      <text x="325" y="58" {...t} fontSize="10" fill="#c3aaff">凑够段内 60s 点数</text>
      <text x="325" y="74" {...t} fontSize="10" fill="#c3aaff">平滑拼接点</text>
      <text x="325" y="90" {...t} fontSize="10" fill="#c3aaff">保持真实速度波动</text>
      <line x1="410" y1="60" x2="450" y2="60" stroke="rgba(233,237,247,0.5)" strokeWidth="1.5" markerEnd="url(#syn-arrow)" />
      <rect x="450" y="20" width="170" height="80" rx="8" fill="rgba(58,227,255,0.08)" stroke="rgba(58,227,255,0.5)" />
      <text x="535" y="40" {...t} fontWeight="600">② 均速对齐 + 坡度调制</text>
      <text x="535" y="58" {...t} fontSize="10" fill="#9aa6c0">缩放至段均速</text>
      <text x="535" y="74" {...t} fontSize="10" fill="#9aa6c0">上坡 v×(1−0.025·g)</text>
      <text x="535" y="90" {...t} fontSize="10" fill="#9aa6c0">下坡略快</text>
      <line x1="620" y1="60" x2="660" y2="60" stroke="rgba(233,237,247,0.5)" strokeWidth="1.5" markerEnd="url(#syn-arrow)" />
      <rect x="660" y="20" width="150" height="80" rx="8" fill="rgba(164,115,255,0.08)" stroke="rgba(164,115,255,0.5)" />
      <text x="735" y="40" {...t} fontWeight="600">③ 算深度特征</text>
      <text x="735" y="58" {...t} fontSize="10" fill="#c3aaff">a=Δv/Δt</text>
      <text x="735" y="74" {...t} fontSize="10" fill="#c3aaff">v_p85/e_acc/e_aero…</text>
      <text x="735" y="90" {...t} fontSize="10" fill="#c3aaff">共 9 个</text>
      <text x="410" y="130" {...t} fill="#9aa6c0" fontSize="11">合成 v(t) 曲线 → 加速度 a = Δv/Δt（m/s²）→ 能量积分 / 分位数 / 占比 → 深度特征</text>
      <text x="410" y="152" {...t} fill="#9aa6c0" fontSize="11">实测校验：e_aero r=0.89 · v_p85 r=0.85 · e_acc r=0.78 · absa_mean r=0.28</text>
    </svg>
  )
}

/** SVG 按行程分组交叉验证示意 */
function CvDiagram() {
  return (
    <svg viewBox="0 0 820 120" className="hw-svg" role="img" aria-label="按行程分组交叉验证">
      <text x="20" y="22" fill="#e9edf7" fontSize="12">按「整趟行程」划分训练/测试集（防相邻 60s 点泄漏）：</text>
      {[0,1,2,3,4].map(i => (
        <g key={i}>
          <rect x="20" y={34+i*16} width="760" height="10" rx="3" fill="rgba(255,255,255,0.04)" />
          <rect x={20+i*152} y={34+i*16} width="152" height="10" rx="3" fill="rgba(255,96,114,0.55)" />
          <text x={190+i*152} y={43+i*16} fill="#ff6072" fontSize="10">测试折 {i+1}</text>
        </g>
      ))}
      <text x="20" y="112" fill="#9aa6c0" fontSize="11">5 折中每折把若干整趟行程作为「新线路」测试，其余行程训练；最终 R² 取 5 折平均。</text>
    </svg>
  )
}

export default function HydrogenHowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <div className="howitworks-overlay" onClick={onClose}>
      <div className="howitworks-panel" onClick={(e) => e.stopPropagation()}>
        <div className="howitworks-head">
          <h3>⚡ 氢能消耗预测 · 技术原理</h3>
          <button className="btn-close" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="howitworks-body">
          <p className="hw-lead"><b>摘要：</b>用两辆 H49 燃料电池重卡 2026-08 实车数据（60s×5504 条），经数据清洗、外部特征回填、5km 段聚合，构造 18 维特征；新线路分段后先按「道路等级×均速」从实车片段库<b>合成行驶工况</b>，再由梯度提升树（HistGB）预测每段氢耗。按行程分组 5 折交叉验证 R²≈0.34、RMSE≈0.053 kg/km。</p>

          <Sec num="1" title="问题定义">
            <p>目标：给定一条<b>新线路</b>（起点/终点），预测氢能重卡（49t 半挂）整线氢耗（kg）与百公里氢耗（kg/100km）。</p>
            <p><b>可用输入</b>：导航路线分段（段长/均速/坡度/海拔/温度/风速/湿度/道路等级/时段）。</p>
            <p><b>核心难点</b>：只有「平均速度」，没有「秒级速度曲线」——而氢耗对加减速、启停细节极敏感（见 §3.3 工况合成）。</p>
          </Sec>

          <Sec num="2" title="数据：来源与处理">
            <Sub title="2.1 数据来源">
              <Table head={["数据","来源","官方换算（rate, offset）","本方案用法"]} rows={[
                ["实车 CAN（80 列）","两辆 H49 重卡 2026-08，60s×5504 条","speed 车速 ×0.1；lon/lat ×1e-6；h2_remain ×0.01→kg；温度类 −40","速度÷10、经纬度÷1e6；h2_remain 用 CSV 已换算的 kg；车辆温度未使用（改用 ERA5 环境温度）"],
                ["海拔/坡度","terrarium DEM 瓦片（AWS S3，静态）","无需换算（公制）","回填每点海拔，段内差分得坡度"],
                ["温度/风速/湿度/降水","Open-Meteo ERA5 历史再分析（免费）","无需换算（公制）","按点×时刻回填历史天气"],
                ["道路等级","高德 regeo 道路名 + 规则映射（OSM 可用时优先）","—","段等级序数"],
              ]} />
            </Sub>
            <Sub title="2.2 清洗与单位统一">
              <ol>
                <li><b>官方换算口径</b>：按《数据计算方法》文档，实际值 = 原始值 × rate + offset；speed ×0.1、lon/lat ×1e-6、h2_remain ×0.01(kg)、温度类 −40（本方案未使用车辆温度）。CSV 中 h2_remain 已按 ×0.01 换算为实际 kg</li>
                <li>目标过滤：氢耗 ≤0 或 &gt;1 的行剔除（采集噪声）</li>
                <li>速度单位：原始车速为 ×10 编码，统一 <Tex math="v_{km/h}=v_{raw}/10" /></li>
                <li><b>数据质量修正</b>：原始「纵向加速度」列实为经度（值域 116~131），弃用；加速度改为 60s 平均速度差分 <Tex math="a=\Delta v/\Delta t" />，Δv 单位 km/h、Δt=60s，再 ÷3.6 得 m/s²</li>
              </ol>
            </Sub>
            <Sub title="2.3 目标变量（真实氢耗）">
              <p>目标变量 <b>h2_consum_per_sec 即由氢气剩余量差分得到</b>（每 60s 采样点消耗量，kg；列名 per_sec 为采集命名，实为 60s 聚合值），与 h2_remain 差分同源同单位（实测比例≈1）。本方案直接以氢气剩余量差分构造目标：</p>
              <Tex block math="\Delta H_{2,i} = -\big(H_{2,remain,i} - H_{2,remain,i-1}\big),\quad 仅取 0<\Delta H_2<1\,kg" />
              <p>段氢耗（目标）：<Tex math="h_{2,per\,km} = \sum_{i\in seg}\Delta H_{2,i}\;\big/\;L_{seg}" />，中位 ≈5.1 kg/100km，符合重卡实况。</p>
            </Sub>
            <Sub title="2.4 段聚合">
              <p>按行程（相邻时间差 &gt;300s 视为新行程）把 60s 点按 5km 累计里程分桶（`sid=int(cum/5)`，段长≈5km±一个点距）→ <b>1066 个路段样本</b>（两车混合，过滤 h2_per_km∈(0.02,0.5) 且 len_km≥1 后）。每段统计：均速/坡度/海拔/温度/风速/湿度用<b>里程加权平均</b>（每点按它代表的里程加权，避免低速点灌水、与预测端高德整段均速口径对齐）、道路等级取众数、时段取段首点、段长为距离求和、目标 kg/km 为总氢耗÷总里程。</p>
            </Sub>
            <Sub title="2.5 训练 vs 预测的数据来源口径差异（透明披露）">
              <Table head={["特征","训练来源（ml/backfill.py）","预测来源（前端实时抓取）"]} rows={[
                ["里程 len_km","实车 GPS 相邻点 haversine 累计","高德路线段里程"],
                ["均速 v_mean","实车 CAN 车速（原始 ×0.1）","高德路段均速"],
                ["坡度 / 海拔","terrarium DEM 瓦片（AWS S3）","同左（DEM 高程采样）"],
                ["温度 / 风速 / 湿度","ERA5 历史再分析（open-meteo）","QWeather 逐小时预报（按出发时间+位置）"],
                ["时段 hour","段起点时刻","出发时间 + 累计时长推算"],
                ["道路等级 lv","高德 regeo 道路名 + 规则推断","OSM 真实路网匹配"],
                ["质量 mass_kg","行程级能量平衡反推（ml/mass_est.py）","用户输入载重 → 总质量 = 整备 + 载重"],
                ["9 个深度特征","实车 v/a 片段库合成","同左（同一套 feat.py 口径）"],
              ]} />
              <p><b>已知口径差异（如实披露）</b>：① <b>天气源不同</b>——训练用 ERA5 历史再分析（模型回算值），预测用 QWeather 实时预报，同点同时刻可能差数度 / 数 m/s；② <b>道路等级来源不同</b>——regeo 关键词推断 vs OSM 地图匹配，个别路段等级可能不一致（如 S12 机场高速）；③ <b>里程口径不同</b>——GPS 直线累计 vs 高德路线里程（含道路曲率，通常略大），整体约 1% 量级；④ <b>质量来源不同</b>——训练用行程级能量平衡反推（含 η/Crr/CdA 假设，系统偏差用官方锚点校准，详见 §2.6），预测用用户输入载重 + 整备；口径统一为"总质量 kg"，但反推值带约 ±10% 系统偏差。</p>
            </Sub>
            <Sub title="2.6 质量特征：行程级能量平衡反推（ml/mass_est.py）">
              <p>训练数据没有载重列，但有<b>三驱动电机电流/电压</b>（官方换算：电流 offset −1000A、电压 ×0.1，负电流=再生回收）。用<b>整趟行程的能量守恒</b>反推质量——电机输出的驱动电能 = 克服四阻力的功；空调等附件走并联支路、不经驱动电机，天然不进该方程：</p>
              <Tex block math="E_{drive} = m\,g\sum_i(\sin	heta_i + C_{rr}\cos	heta_i)v_i\Delta t_i + \sum_i	frac12
ho C_dA v_i^3\Delta t_i" />
              <Tex block math="\Rightarrow\quad m = rac{E_{drive} - E_{aero}}{g\sum_i(\sin	heta_i + C_{rr}\cos	heta_i)\,v_i\Delta t_i}" />
              <p>动能项 <Tex math="\sum m a v\Delta t = 	frac12m(v_{end}^2-v_{start}^2)pprox 0" />（起终点速度相近，闭合行程消去）；只在驱动点（P_elec&gt;5kW）积分，随机噪声被整行程平均掉。实测：车辆1 解出 3 趟（中位 32.0t）、车辆2 解出 14 趟（中位 36.1t，范围 11.3~55.5t 覆盖空/满载）；解不出的行程用该车中位填充。系统偏差（η/Crr/CdA 假设 + CAN 换算）用官方锚点（满载 49t）校准。</p>
              <p><b>效果</b>：加入质量特征后按行程分组 CV R² 0.378 → <b>0.384</b>（RMSE 0.0483→0.0481）；载重响应方向正确——同一路段满载 49t 预测 6.54、空载 10t 预测 5.79 kg/100km（满载高 13%）。预测时用户输入载重，总质量 = 整备 9.7t + 载重。</p>
              <p><b>为什么不用考虑「氢气变少」</b>：H49 储氢约 56~80 kg（70MPa），占空载总重 &lt;0.8%、满载 &lt;0.2%；跑完 1000km 烧掉约 70kg 氢，总重变化 &lt;1%——比载重差异（10~40t）小两个数量级，动态减重对氢耗的影响可忽略，故质量特征用固定值即可。</p>
            </Sub>
          </Sec>

          <Sec num="3" title="特征工程（19 维，两级）">
            <Sub title="3.1 第一级：新线路可直接获取（10 个）">
              <Table head={["特征","含义","来源"]} rows={[
                ["len_km / v_mean","段长 km / 段均速 km/h","高德路线"],
                ["grade_mean / elev_mean","平均坡度 % / 平均海拔 m","DEM"],
                ["temp_mean / wind_mean / hum_mean","温度℃ / 风速km/h / 湿度%","天气(ERA5/QWeather)"],
                ["hour / lv","到达时段 / 道路等级序数(高速0…其他6)","出发时间 / OSM·高德"],
              ]} />
            </Sub>
            <Sub title="3.2 第二级：工况深度特征（9 个）——含义与意义">
              <p><b>为什么非要合成这些特征</b>：新线路系统只给"平均速度/坡度"等粗粒度信息，而<b>氢耗对加减速、启停细节极其敏感</b>——同样均速 70，匀速巡航 vs 频繁加减速，氢耗可差 20~50%。系统无法直接测量新线路的秒级 v(t)，所以从实车建"工况片段库"，按段均速/等级拼接出最可能的速度曲线（§3.3），再算出下面 9 个特征，把"实车的速度波动模式"迁移到新线路。实证：加上这些合成特征后段级 R² 从 0.31（仅可获取特征）提升到 0.45+（调研实测），是模型最大的提升来源。</p>
              <p>每个特征代表什么、为什么对氢耗重要（Δt=60s，L=段长 km，v 为 km/h，a 为 m/s²）：</p>
              <Table head={["特征","中文名","物理含义","为什么重要"]} rows={[
                ["v_std","速度波动","速度围绕均值的标准差（km/h）","波动大=频繁加减速/路况复杂，同样均速更费氢；区分「匀速巡航」与「走走停停」"],
                ["v_p85","巡航速度","85% 时间不超过的速度，接近实际巡航速度","空气阻力 ∝ v³，巡航速度决定高速段能量主体"],
                ["absa_mean","平均加速度强度","加减速平均幅度（m/s²）","反映驾驶激进程度；加速度越大，惯性损耗（½mv²）越多"],
                ["a_p90","强加速水平","最猛 10% 时刻的加速度（m/s²）","捕捉急加速/急刹车——贡献不成比例的氢耗"],
                ["cruise_ratio","巡航占比","|a|&lt;0.15 的平稳行驶时间占比","高=电堆多在高效区=省氢；低=频繁变工况"],
                ["stop_ratio","停车占比","车速&lt;1km/h 的时间占比","高=起步频繁+附件时间被摊薄，城市段费氢主因"],
                ["e_acc","加速能量/km","每公里用于加速（克服惯性）的轮边能量 Σmax(v·a,0)·Δt/L","加速的动能要用氢来买，不可逆（除非下坡回收）"],
                ["e_aero","空气阻力能量/km","每公里撞开空气的轮边能量 Σv³·Δt/L","高速重卡最大能量项，满载 49t 高速时占驱动能量一半以上"],
                ["e_grade_up","上坡能量/km","每公里克服重力爬坡的轮边能量 Σmax(v·g,0)·Δt/L","爬坡直接费氢；只计上坡（下坡可回收/滑行）"],
              ]} />
              <Tex block math="E_{acc}=\sum_i \max(v_i\,a_i,\,0)\,\Delta t\,/\,L,\quad E_{aero}=\sum_i v_i^3\,\Delta t\,/\,L,\quad E_{grade}=\sum_i \max(v_i\,g_i,\,0)\,\Delta t\,/\,L" />
            </Sub>
            <Sub title="3.3 工况合成（核心创新）">
              <p><b>为什么需要</b>：新线路只有均速，而氢耗对秒级加减速/启停极敏感；合成出与实车统计一致的 v(t) 序列，才能算准能量类特征。</p>
              <p><b>方法</b>：实车数据按「道路等级 × 均速」分 8 桶建<b>60s 速度片段库</b>；对每段：① 从对应桶随机拼接 v 片段（凑够段内点数）→ ② 平滑 + 按段均速缩放对齐 → ③ 坡度调制 <Tex math="v\leftarrow v\,(1-0.025\,g)" /> → ④ 加速度由 <Tex math="a=\Delta v/\Delta t" /> 得到 → ⑤ 算 9 个深度特征。</p>
              <SynthDiagram />
              <p className="hw-note">合成质量实测：e_aero r=0.89、v_p85 r=0.85、e_acc r=0.78；absa_mean r=0.28（60s 差分加速度合成偏弱，为当前主要瓶颈之一）。</p>
            </Sub>
          </Sec>
          <Sec num="4" title="模型选择与训练">
            <Sub title="4.1 为什么选 HistGB（直方图梯度提升树）">
              <Table head={["需求","线性/Ridge","GBR/HistGB"]} rows={[
                ["特征 VIF 普遍较高（多重共线性）","✗ 共线会放大系数、不稳定","✓ 按最优分裂选特征，天然免疫"],
                ["特征尺度差异大（速度/坡度/能量积分）","✗ 需标准化","✓ 对尺度不敏感，无需归一"],
                ["存在非线性与交互（v³、v·a、v·g）","✗ 需手工构造","✓ 树可隐式拟合"],
                ["样本量小（1071 段）","✓ 尚可","✓ 稳健、调参少"],
              ]} />
              <p>实测对比 GBR/线性/Ridge：GBR 系列最优（与团队实测一致）；HistGB 用直方图分箱，训练快、内存省，是其工程化实现。</p>
            </Sub>
            <Sub title="4.2 超参数与调参">
              <Table head={["超参","取值","说明"]} rows={[
                ["max_iter（树数量）","350","足够收敛；更多过拟合风险增"],
                ["learning_rate（学习率）","0.05","小步长 + 多树，稳"],
                ["max_depth（单树深度）","5","控制复杂度，防过拟合"],
                ["l2_regularization","1.0","叶节点 L2 正则"],
              ]} />
              <p>调参方法：网格粗搜 + 按行程分组 CV 验证（避免用 shuffle 分数误导）。未做精细搜索——在样本量下已接近平台期。</p>
            </Sub>
            <Sub title="4.3 训练与验证（防泄漏）">
              <p>18 特征 → 目标段氢耗 kg/km。用<b>按行程分组 5 折交叉验证</b>：把整趟行程当「新线路」放入测试折，其余行程训练——相邻 60s 点只在同一折内，杜绝时间泄漏（随机打乱会虚高）。</p>
              <CvDiagram />
              <p>验证通过后，用全部 1071 段重训一次，导出 <code>model.joblib</code> + 工况片段库 <code>templates.json</code>。</p>
            </Sub>
          </Sec>

          <Sec num="5" title="预测部署：输入、来源与兜底">
            <Sub title="5.1 预测输入清单（每段）">
              <Table head={["特征","在线来源","缺失时兜底"]} rows={[
                ["len_km / v_mean","高德路线 step（distance/duration）","高德兜底；再缺用整线均值"],
                ["grade_mean / elev_mean","terrarium DEM 瓦片（已缓存）","0% / 100m（并标注缺失）"],
                ["temp_mean","QWeather 24h 逐小时（GCJ-02）→ 高德天气日预报","默认 20℃（界面标注“未用真实天气”）"],
                ["wind_mean","同上","默认 10 km/h"],
                ["hum_mean","同上","默认 60%"],
                ["hour","出发时间 + 累计时长","默认 12 时"],
                ["lv 道路等级","OSM 匹配（Overpass）→ 高德 regeo 道路名规则推断","规则推断（界面标注“OSM 不可用”）"],
                ["9 个深度特征","工况合成（片段库+均速+坡度）","无兜底：总是可合成（只需均速/等级/坡度）"],
              ]} />
            </Sub>
            <Sub title="5.2 兜底策略（明确透明，绝不假装真实）">
              <ol>
                <li>天气：QWeather → 高德日预报 → <b>默认 20℃/60%/10km/h</b>，预测结果按“缺真实天气的近似值”标注</li>
                <li>道路等级：OSM → 高德 regeo 规则推断 → <b>other</b>，界面标注来源</li>
                <li>坡度/海拔：DEM 静态数据，本地缓存，缺失率极低；缺失时按 0/100m 并标注</li>
                <li>深度特征：仅依赖均速/等级/坡度，<b>不依赖天气</b>，总是能合成</li>
              </ol>
              <p className="hw-note">⚠️ 说明：当天气 0/41、OSM 不可用时，预测的温度/湿度/风速为默认值、道路等级为规则推断，工况合成与模型计算仍是真实的——但结果是“缺外部数据的近似值”，前端会如实标注。</p>
            </Sub>
            <Sub title="5.3 预测流程">
              <FlowDiagram />
              <p>后端 <code>POST /api/predict-hydrogen</code>：收系统分段 → python <code>predict.py</code>（与训练同一套 feat.py 口径）→ 逐段合成工况 → 18 特征 → 模型 → 每段 kg/km × 里程 = 总氢耗。</p>
            </Sub>
          </Sec>

          <Sec num="6" title="结果与评估（实测）">
            <Sub title="6.1 交叉验证">
              <p><b>按行程分组 5 折 CV：R²=0.384，RMSE=0.048 kg/km</b>（目标中位 ≈5.12 kg/100km；2026-08-22 修正训练里程 haversine + 加入行程级质量特征后重训，详见 §6.4 注③）。此值使用真实 v 差分加速度，为诚实水平。</p>
            </Sub>
            <Sub title="6.2 特征重要性（permutation，按 R² 下降量）">
              <Table head={["特征","重要性"]} rows={[
                ["v_mean 均速","1.21"], ["e_aero 空阻能量","0.20"], ["hour 时段","0.12"],
                ["hum_mean 湿度","0.12"], ["elev_mean 海拔","0.11"], ["v_p85 巡航速度","0.08"],
                ["temp_mean 温度","0.07"], ["wind_mean 风速","0.06"], ["len_km 段长","0.06"],
                ["e_acc 加速能量","0.03"], ["mass_kg 质量","0.01"], ["其余","≤0.02"],
              ]} />
            </Sub>
            <Sub title="6.3 按道路等级：实测 vs 模型（kg/100km）">
              <Table head={["等级","段数","均速中位","实测中位","实测均值","P90","模型典型值"]} rows={[
                ["高速","278","76.6","4.06","6.22","10.4","≈4–5"],
                ["国道","38","67.9","5.07","5.85","10.4","≈5–6"],
                ["省道","49","59.1","6.84","10.22","23.6","≈7–11"],
                ["城市","65","39.9","8.24","11.37","23.4","≈8–13"],
              ]} />
              <p>城市段氢耗高的物理原因：低速（时间摊薄附件能耗）+ 频繁启停（49t 起步动能大）+ 电堆低效区运行——与实车统计一致，非模型虚构。</p>
            </Sub>
            <Sub title="6.4 预测校准（均值 → 中位）">
              <p><b>为什么需要校准</b>：HistGB 最小化均方误差，输出是每段的条件<b>期望值 E[y|x]（均值）</b>；而氢耗目标<b>右偏（长尾）</b>——少数极端高耗段（满载爬坡/严重拥堵）拉高均值，使均值 &gt; 中位数。因此模型对每段的预测系统性偏高，低速段（方差大、右偏更重）高估最明显。</p>
              <p><b>偏差来源（训练集按行程分组 CV 实测）</b>：</p>
              <Table head={["均速区间 (km/h)","预测−实测中位偏差 (kg/100km)"]} rows={[
                ["0–40","+0.76"], ["40–60","+0.96"], ["60–80","+0.09"], ["80+","+0.50"], ["整体","+1.0%（相对误差）"]
              ]} />
              <p><b>校准公式</b>（分段常数偏差修正，按重训后 CV 实测偏差表逐档扣除）：</p>
              <Tex block math="h_{2,cal}=h_{2,pred}-bias(v)" />
              <Tex block math="bias(v)=\begin{cases}0.76 & v&lt;40\\\\ 0.96 & 40\le v&lt;60\\\\ 0.09 & 60\le v&lt;80\\\\ 0.50 & v\ge 80\end{cases}\quad\mathrm{kg/100km}" />
              <p>其中 v 为段均速（km/h）。校准把各均速段的"均值估计"拉回"中位水平"：低速段（城市/拥堵）扣 0.76~0.96、中速巡航扣 0.09、高速扣 0.50 kg/100km，整体相对误差从 +1.0% 降至接近 0。</p>
              <p className="hw-note">边界：① 这是<b>经验偏差修正</b>（来自 5 折 CV 的 out-of-sample 偏差），不是物理公式；② 只把"均值估计"拉回"中位水平"，不改变路段间的相对排序；③ 2026-08-22 已随"训练里程 haversine 修复"用 ml/calib_check.py 重拟合本表；若训练数据分布再变化，需再次重跑重拟合；④ 业务上如需"最坏情况"（续航保险），应看未校准值或高分位。</p>
            </Sub>
          </Sec>

          <Sec num="7" title="局限与展望">
            <ul>
              <li><b>60s 颗粒度</b>：加速度只能由 60s 平均速度差分近似，秒级加速/起步细节丢失——当前 R²≈0.38 的主要瓶颈；拿到秒级数据可显著提升</li>
              <li><b>载重未知</b>：氢耗对载重最敏感，当前学习「平均载重」水平；有载重列可大幅改善</li>
              <li><b>外部数据依赖</b>：天气/OSM 在线源偶发不可用，降级为默认值/规则推断（§5.2 透明标注）</li>
              <li><b>工况模板</b>：可随更多实车数据扩充；坡度调制系数、启停参数可继续用实车校准</li>
            </ul>
          </Sec>
        </div>
        <div className="howitworks-foot">
          <span>模型：HistGB · 按行程分组 CV · R²≈0.34 · 数据/相关性/报告均为实测</span>
          <button className="btn-primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  )
}
