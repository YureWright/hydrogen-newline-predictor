# -*- coding: utf-8 -*-
"""你的模型入口 —— 统一格式（stdin JSON -> stdout JSON）
复制本目录为 data/models/<你的id>/ 并按协议实现 predict。
"""
import json, sys

def main():
    payload = json.loads(sys.stdin.read())
    segs = payload.get('segments', [])
    RATE = 0.045  # 示例：kg/km（4.5 kg/100km）
    out = []
    for i, s in enumerate(segs):
        dist = s.get('distanceKm', 1.0)
        out.append({'index': s.get('index', i), 'h2_kg': round(RATE * dist, 4)})
    print(json.dumps({'segments': out}, ensure_ascii=False))

if __name__ == '__main__':
    main()
