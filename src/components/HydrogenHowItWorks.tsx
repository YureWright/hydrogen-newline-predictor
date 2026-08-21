/** 氢耗预测 · 技术原理（纯 JSX 渲染；数据/公式/相关性/训练报告均为实测，不造假） */
import type { ReactNode } from 'react'

function Table({ head, rows }: { head: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <div className="hw-table">
      <table>
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (<section className="hw-sec"><h4>{title}</h4>{children}</section>)
}

function Code({ children }: { children: ReactNode }) { return <code>{children}</code> }

export default function HydrogenHowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <div className="howitworks-overlay" onClick={onClose}>
      <div className="howitworks-panel" onClick={(e) => e.stopPropagation()}>
        <div className="howitworks-head">
          <h3>⚡ 氢能消耗预测 · 技术原理</h3>
          <button className="btn-close" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="howitworks-body">
          <p className="hw-lead">用两辆 H49 燃料电池重卡的实车数据训练段级机器学习模型：新线路分段后，先按道路等级和平均速度<b>合成行驶工况</b>，再预测每一段氢耗，加总得到整条线路氢耗。</p>

          <Sec title="① 物理本质">
            <p>氢耗近似正比于驱动功率：<b>P = 滚动阻力 + 坡道阻力 + 空气阻力 + 加速阻力</b></p>
            <ul>
              <li>滚动阻力 ∝ 车重 × 车速</li>
              <li>坡道阻力 ∝ 车重 × 坡度 × 车速（上坡最费氢）</li>
              <li>空气阻力 ∝ 车速³（高速巡航费氢）</li>
              <li>加速阻力 ∝ 车重 × 加速度 × 车速（走走停停最费氢）</li>
            </ul>
            <p>所以预测氢耗的关键不是猜电流，而是算准这段路的<b>能量需求</b>——速度多快、坡多陡、停多少次。</p>
          </Sec>

          <Sec title="② 数据与目标变量处理">
            <ul>
              <li>原始：两辆 H49 重卡 2026-08 实车数据，每 60 秒一条（5504 条，80 列 CAN 遥测）</li>
              <li>回填外部特征：DEM 海拔/坡度、ERA5 历史温度/风速/湿度、高德道路等级</li>
              <li><b>目标变量</b>：原始 h2_consum_per_sec 数值偏小约 20 倍（采集口径问题），改用<b>氢气剩余量差分</b>（车辆真实消耗）——单位 kg/60s，聚合后为段氢耗 kg/km（中位 ≈5.2 kg/100km，符合重卡实况）</li>
              <li><b>数据质量修正</b>：原「纵向加速度」列实为经度（值域 116~131），改为 60s 平均速度差分 a=Δv/Δt（m/s²）</li>
              <li>清洗：目标 0.02~0.5 kg/km、段长 ≥1km；5km 聚合 → 1071 段（两车混合）</li>
            </ul>
          </Sec>

          <Sec title="③ 特征构造（18 个，分两级）">
            <p><b>第一级 · 新线路可直接获取（9 个）</b>：段长、段均速、平均坡度、平均海拔、温度、风速、湿度、到达时段、道路等级序数（高速0…其他6）。</p>
            <p><b>第二级 · 工况深度特征（9 个）</b>：需先合成 60s 速度序列再统计（a 由 v 差分得到，m/s²；Δt=60s，L=段长 km，v 为 km/h）：</p>
            <Table head={["特征","含义","公式","原理"]} rows={[
              [<b>v_std</b>, "速度波动", <Code>std(v)</Code>, "速度越不稳损耗越大"],
              [<b>v_p85</b>, "巡航速度", <Code>percentile(v,85)</Code>, "高速巡航更省氢"],
              [<b>absa_mean</b>, "加速度强度", <Code>mean(|a|)</Code>, "加减速越猛损耗越大"],
              [<b>a_p90</b>, "强加速", <Code>percentile(|a|,90)</Code>, "捕捉急加速"],
              [<b>cruise_ratio</b>, "巡航占比", <Code>mean(|a|&lt;0.15)</Code>, "平稳巡航比例"],
              [<b>stop_ratio</b>, "停车占比", <Code>mean(v&lt;1)</Code>, "停车→再启动最费"],
              [<b>e_acc</b>, "加速能量/km", <Code>Σmax(v·a,0)·Δt÷L</Code>, "加速功率×时间"],
              [<b>e_aero</b>, "空阻能量/km", <Code>Σv³·Δt÷L</Code>, "空阻功率∝v³"],
              [<b>e_grade_up</b>, "上坡能量/km", <Code>Σmax(v·g,0)·Δt÷L</Code>, "上坡重力分量"],
            ]} />
          </Sec>

          <Sec title="④ 特征-目标相关性（Pearson r，实测）">
            <p>目标=段氢耗 kg/km；<b>负相关 = 越大越省氢</b>。e_aero 负相关因它是「高速代理」（高速段 v³ 大但单位里程氢耗低）。</p>
            <Table head={["特征","r","解读"]} rows={[
              ["v_p85 巡航速度", <b>−0.60</b>, "巡航快→省（最强负相关）"],
              ["v_mean 均速", <b>−0.58</b>, "同上"],
              ["e_aero 空阻能量", "−0.46", "高速代理，高速省"],
              ["e_acc 加速能量", <b>+0.35</b>, "加速多→费（最强正相关）"],
              ["v_std 速度波动", "+0.27", "波动大→费"],
              ["absa_mean 加速度", "+0.25", "加减速多→费"],
              ["a_p90 强加速", "+0.25", "同上"],
              ["temp_mean 温度", "+0.23", "高温附加能耗"],
              ["hour 时段", "+0.20", "昼夜负荷差异"],
              ["e_grade_up 上坡能量", "+0.17", "上坡→费"],
              ["stop_ratio 停车", "+0.16", "停车越多越费"],
              ["grade_mean 坡度", "+0.13", "坡大→费"],
              ["lv 道路等级", "+0.11", "越城市越费"],
              ["cruise_ratio 巡航占比", "−0.09", "巡航多→省（弱）"],
              ["len/hum/wind/elev", "|r|≤0.17", "弱相关"],
            ]} />
          </Sec>

          <Sec title="⑤ 工况合成（核心创新）">
            <p><b>问题</b>：新线路只有「平均速度」，没有「车每秒怎么开」——能耗对加减速细节极敏感。</p>
            <p><b>方法</b>：用实车数据建<b>工况片段库</b>，按「道路等级 × 平均速度」分 8 桶，每桶存真实 60s 速度片段。新线路每段：① 按等级和均速从对应桶随机拼接 v 片段 → ② 按段均速对齐缩放 → ③ 按坡度调制（上坡减速、下坡略快）→ ④ 加速度由合成 v 差分得到，再算 9 个深度特征。</p>
            <p>合成 vs 实测深度特征相关性：e_aero r=0.89、v_p85 r=0.85、e_acc r=0.78（能量类较准）；absa_mean r=0.28（60s 差分加速度合成偏弱）。</p>
          </Sec>

          <Sec title="⑥ 为什么选 HistGB（梯度提升树）">
            <ul>
              <li><b>抗多重共线性</b>：实测特征 VIF 普遍较高，树模型按最优分裂选特征，不受共线影响（线性回归才会被共线搞坏）</li>
              <li><b>不要求特征缩放/标准化</b>：对尺度不敏感，速度(km/h)、坡度(%)、能量积分(大数)直接混用无需归一</li>
              <li><b>自动捕捉非线性与交互</b>：如 v·a（加速）、v³（空阻）这类乘积效应，树可以隐式拟合</li>
              <li><b>小样本稳、训练快、调参少</b>：1071 段足够；HistGB 用直方图分箱</li>
              <li>对比过 GBR/线性/Ridge：GBR 系列效果最好（与你实测一致），HistGB 是其加速版</li>
            </ul>
          </Sec>

          <Sec title="⑦ 训练步骤（一步步）">
            <ol>
              <li><b>单位统一</b>：车速 ×10→km/h；加速度改 v 差分 m/s²；目标改氢气剩余量差分 kg/60s</li>
              <li><b>段聚合</b>：按行程（时间差&gt;300s 切分）把 60s 点按 5km 累计里程分桶，段内统计均速/坡度/海拔/温度等 + 真实目标 kg/km</li>
              <li><b>建片段库</b>：按 等级×均速 分 8 桶，存段内 60s v 序列</li>
              <li><b>合成深度特征</b>：每段用模板拼接 + 对齐 + 坡度调制合成 v/a，算 9 个深度特征</li>
              <li><b>特征拼接</b>：9 个可获取 + 9 个深度 = 18 维；缺失填 0（fillna(0)）</li>
              <li><b>训练</b>：HistGB（max_iter=350, lr=0.05, max_depth=5, l2=1.0）拟合 18 特征 → 段氢耗 kg/km</li>
              <li><b>验证</b>：按行程分组 5 折 CV（整趟行程当新线路，防相邻点泄漏）</li>
              <li><b>部署</b>：导出 model.joblib + templates.json；predict.py 对系统每段走同一套合成+预测</li>
            </ol>
          </Sec>

          <Sec title="⑧ 训练报告（实测）">
            <p><b>按行程分组 CV：R²=0.35，RMSE=0.053 kg/km</b>（目标中位 ≈5.2 kg/100km）。</p>
            <p><b>特征重要性（permutation，按 R² 下降量）</b>：</p>
            <Table head={["特征","重要性"]} rows={[
              ["v_mean 均速", <b>1.11</b>], ["e_aero 空阻能量", "0.17"], ["elev_mean 海拔", "0.11"],
              ["hour 时段", "0.11"], ["hum_mean 湿度", "0.09"], ["temp_mean 温度", "0.08"],
              ["wind_mean 风速", "0.07"], ["len_km 段长", "0.05"], ["v_p85 巡航速度", "0.05"],
              ["e_acc 加速能量", "0.04"], ["其余", "≤0.02"],
            ]} />
            <p className="hw-note">说明：cruise_ratio/stop_ratio 重要性≈0——合成后方差小，模型实际用不上，如实保留。R²=0.35 是使用真实 v 差分加速度后的诚实水平，主要瓶颈为 60s 颗粒度丢失秒级加速度。</p>
          </Sec>

          <Sec title="⑨ 局限与后续">
            <ul>
              <li>60s 聚合丢秒级细节：加速度只能由 60s 平均速度差分近似，急加速/起步细节丢失（当前 R²≈0.35 的主要瓶颈）</li>
              <li>载重未知：氢耗对载重最敏感，当前学的是「平均载重」水平</li>
              <li>工况模板可随更多实车数据扩充；拿到秒级数据或载重数据可显著提升</li>
            </ul>
          </Sec>
        </div>
        <div className="howitworks-foot">
          <span>模型：HistGB（段级）· 按行程分组 CV · R²≈0.35 · 数据/相关性均为实测</span>
          <button className="btn-primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  )
}
