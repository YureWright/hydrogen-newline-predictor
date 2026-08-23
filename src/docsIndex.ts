/// <reference types="vite/client" />
﻿/** 文档库清单：全量文档分组（项目核心 / 知识库科普 / 概念公式 / 文献笔记中英文） */
export interface DocEntry {
  id: string
  title: string
  globKey?: string          // import.meta.glob 的相对路径 key（md 文档）
  kind: 'md' | 'html' | 'tech'
  htmlSrc?: string          // html 文档的静态路径（public/）
  hint?: string
}
export interface DocGroup { group: string; items: DocEntry[] }

const KB = '../氢能源车辆氢耗建模知识库'
const DOCS = '../docs'

const CN_NOTES = [
  '曾小华2019_氢耗分析模型与应用',
  '朱丹2024_大功率氢燃料电池动力系统节能优化',
  '袁结2022_燃料电池客车系统建模与能量管理策略',
  '杨继斌2026_融合车速预测与强化学习的能量管理',
  '林歆悠2024_里程自适应等效氢耗最小控制',
  '肖兴伟2023_基于模型的燃料电池物流车能量管理',
]
const EN_NOTES = [
  'Ahn2022_HFCV能耗模型',
  'Duan2021_CLTC-P氢耗与续航',
  'Pang2021_多场景敏感性分析',
  'Sulaiman2015_能量管理策略评估综述',
  'Zhao2018_能耗模型对比研究',
  'Simmons2015_动态规划与遗传算法',
  'Topic2022_机器学习预测燃料消耗',
  'Blades2021_真实世界能耗与LCA',
  'Zheng2012_等效燃料消耗评估',
  'Sun2022_PMPC降低氢耗',
  'Tang2022_深度强化学习长寿EMS',
  'Huang2023_DRL增程式FCV能量管理',
  'Lee2020_驾驶风格与能耗预测',
  'Kapusuz2023_机器学习预测轻型车能耗',
  'Savvaris2015_无人机燃料电池效率与控制',
  'Li2015_插电式FCV生态驾驶优化',
  'Kuralay2019_预测控制与燃料经济性',
  'Huang2019_公交数据驱动氢耗',
  'Ahmadi2020_智能能量管理策略',
  'Anwar2022_模糊控制与传感器影响',
  'Yu2019_能量管理方法与氢耗经济性',
  'Kamal2021_神经网络系统建模',
  'Zembi2025_城市客车工况敏感性',
  'Jiang2024_三参数对FCHEV氢耗影响',
]

export const DOC_GROUPS: DocGroup[] = [
  { group: '项目核心', items: [
    { id: 'readme', title: 'README · 项目总览', globKey: '../README.md', kind: 'md' },
    { id: 'worklog', title: 'WORKLOG · 工作日志', globKey: DOCS + '/WORKLOG.md', kind: 'md' },
    { id: 'tech', title: '⚡ 技术原理（ML + 物理模型）', kind: 'tech', hint: '机器学习与物理模型双 Tab 完整原理' },
    { id: 'design', title: '物理模型 · 设计文档（完整版）', kind: 'html', htmlSrc: '/docs/物理氢耗模型_设计方案.html', hint: 'HTML 完整设计：流程图 / 手算工作簿 / 临界角 / SOC 策略' },
    { id: 'ml-research', title: 'ML 建模调研', globKey: DOCS + '/氢耗ML建模调研_20260821.md', kind: 'md' },
    { id: 'data-audit', title: '数据质量审计', globKey: DOCS + '/data-quality-audit.md', kind: 'md' },
    { id: 'prototype', title: '产品原型规格', globKey: DOCS + '/prototype-spec.md', kind: 'md' },
    { id: 'segment-contract', title: '路段数据契约 SegmentData', globKey: DOCS + '/segment-contract.md', kind: 'md' },
    { id: 'seg-research', title: '切分算法调研', globKey: DOCS + '/segmentation-research.md', kind: 'md' },
    { id: 'phy-research', title: '物理模型调研', globKey: DOCS + '/physics-model-research.md', kind: 'md' },
  ] },
  { group: '知识库 · 总览与科普', items: [
    { id: 'kb00', title: '00 · 总览与阅读入口', globKey: KB + '/00_总览与阅读入口.md', kind: 'md' },
    { id: 'kb01', title: '01 · 原理科普：氢耗从哪来', globKey: KB + '/01_原理科普_氢耗从哪来.md', kind: 'md' },
    { id: 'kb02', title: '02 · 公式手册：核心公式', globKey: KB + '/02_公式手册_氢耗计算的核心公式.md', kind: 'md' },
    { id: 'kb03', title: '03 · 调研报告：数据建模', globKey: KB + '/03_调研报告_氢能源车辆氢耗数据建模.md', kind: 'md' },
  ] },
  { group: '知识库 · 概念与公式', items: [
    { id: 'c-resist', title: '行驶阻力与车轮功率', globKey: KB + '/概念与公式/行驶阻力与车轮功率.md', kind: 'md' },
    { id: 'c-fc', title: '燃料电池效率与电堆特性', globKey: KB + '/概念与公式/燃料电池效率与电堆特性.md', kind: 'md' },
    { id: 'c-ems', title: '能量管理策略全景', globKey: KB + '/概念与公式/能量管理策略全景.md', kind: 'md' },
    { id: 'c-factor', title: '氢耗影响因素一览', globKey: KB + '/概念与公式/氢耗影响因素一览.md', kind: 'md' },
    { id: 'c-test', title: '氢耗测试方法', globKey: KB + '/概念与公式/氢耗测试方法.md', kind: 'md' },
  ] },
  { group: '知识库 · 文献笔记（中文）', items: CN_NOTES.map((n, i) => ({
    id: 'cn' + (i + 1), title: n, globKey: KB + '/文献笔记/中文0' + (i + 1) + '_' + n + '.md', kind: 'md' as const,
  })) },
  { group: '知识库 · 文献笔记（英文）', items: EN_NOTES.map((n, i) => ({
    id: 'en' + (i + 1), title: n, globKey: KB + '/文献笔记/英文' + String(i + 1).padStart(2, '0') + '_' + n + '.md', kind: 'md' as const,
  })) },
]

/** import.meta.glob 模式：把全部 md 打包进 bundle（构建后离线可读）；vite 要求 glob 参数为字面量，故内联 */
export const mdFiles: Record<string, string> = import.meta.glob([
  '../README.md',
  '../docs/*.md',
  '../氢能源车辆氢耗建模知识库/*.md',
  '../氢能源车辆氢耗建模知识库/概念与公式/*.md',
  '../氢能源车辆氢耗建模知识库/文献笔记/中文*.md',
  '../氢能源车辆氢耗建模知识库/文献笔记/英文*.md',
], { query: '?raw', import: 'default', eager: true })
