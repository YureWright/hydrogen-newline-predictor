# 单点历史数据函数：队友接入说明

## 交付物

本次交付不是网页，而是仓库里的函数：

`src/route/pointHistory.ts` 中的 `queryPointHistoryRow`。

它的输入只有三个值：

```ts
{ lng: 116.407387, lat: 39.904179, time: '2026-08-20 10:07' }
```

它返回一条与示例 CSV 对齐的 22 列数据：

```ts
import { queryPointHistoryRow } from './src/route/pointHistory'

const result = await queryPointHistoryRow(
  { lng: 116.407387, lat: 39.904179, time: '2026-08-20 10:07' },
  {
    amapKey: process.env.AMAP_KEY,
    qweatherKey: process.env.QWEATHER_KEY,
    qweatherJwt: process.env.QWEATHER_JWT,
    qweatherHost: process.env.QWEATHER_HOST,
  },
)

console.log(result.row) // 22 列的一行对象，可直接写进 CSV
```

## 密钥规则

1. `.env` 只在各自电脑上保存，不发送、不提交、不上传。
2. 只需将 `.env.example` 复制成 `.env`，再由持有密钥的人填写。
3. 没有密钥时函数仍能运行，但道路和天气会明确标注为模拟数据。

## 立刻验证

在仓库目录运行：

```bash
npm run verify:point-row
npm run point:row -- 116.407387 39.904179 "2026-08-20 10:07" --csv
```

第一个命令看到 `13 PASS` 表示函数逻辑正常；第二个命令会输出 CSV 表头和一行数据。

## 数据边界

一个坐标不等于完整路段：道路名称与最近 10 天历史天气会优先走真实服务；里程、均速、坡度、路况、启停等路段字段为确定性模拟测试值，结果中会明确标注 `simulation-test`，不能当作实测采集数据。

## 车辆 CSV 批量跑法

批处理脚本只读取三列：`time_数据采集时间`、`lat_纬度`、`lon_经度`。车辆文件中的经纬度按 `÷1,000,000` 还原，其他车辆遥测列全部丢弃。为保护轨迹隐私，批处理强制离线，不访问高德或天气服务。

```bash
npm run point:batch -- /绝对路径/车辆1.csv /绝对路径/车辆2.csv
```

结果会写入 `outputs/point-history-batch/`，每份结果含三个输入列和 22 个函数输出列；原始文件不会被覆盖。
