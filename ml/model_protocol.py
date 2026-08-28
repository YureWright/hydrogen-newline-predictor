# -*- coding: utf-8 -*-
"""可插拔模型协议 v1 —— 统一封装格式

模型包（每个模型一个目录，放在 data/models/<id>/）：
  meta.json   报名表：{id, name, version, description?, training?}
  predict.py  唯一入口（格式固定）：
                stdin  : {"segments":[{distanceKm,avgSpeedKmh,gradePercent,elevationM,
                                        temperatureC,windSpeedKmh,roadLevel,massKg,...}, ...]}
                stdout : {"segments":[{index?, h2_kg}, ...]}   # 每段一个 h2_kg（kg/段）

规则：
  - 所有模型（不管内部是 sklearn/PyTorch/公式）必须封装成上面的 predict.py 格式
  - 系统只负责：喂输入(固定JSON) → 调 predict.py → 收输出 → 校验每段氢耗
  - 导入时用内置小仿真数据表做"试工"：能出合理输出才算导入成功
  - 内置模型（histgb_ml / physics）天然就是 predict.py 格式，注册为默认基线

用法：
  python model_protocol.py list
  python model_protocol.py smoke <model_id>
  python model_protocol.py run <model_id> <input.json>
  python model_protocol.py import <src_dir>
"""
import json
import os
import shutil
import subprocess
import sys

# stdout/stderr 统一 UTF-8（避免 Windows GBK 控制台打印中文/符号崩）
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)
MODELS_DIR = os.path.join(PROJECT_ROOT, 'data', 'models')
ENTRY = 'predict.py'
TIMEOUT_S = 60

# 内置模型（现有引擎，天然就是 predict.py 格式，注册为默认基线）
BUILTIN_MODELS = {
    "histgb_ml": {
        "name": "机器学习 · HistGB（实车+工况合成）", "version": "1.0.0",
        "script": os.path.join("ml", "predict.py"),
        "description": "两辆H49实车训练的段级模型：工况合成+21特征+梯度提升树",
    },
    "physics": {
        "name": "物理模型（能量守恒+启停）", "version": "1.0.0",
        "script": os.path.join("ml", "physics.py"),
        "description": "四阻力+电堆/电池削峰+启停能耗，纯公式白盒",
    },
}

# 内置小仿真数据表（试工用）：覆盖高速/国道/城市/上下坡/不同均速/载重
SMOKE_SEGMENTS = [
    {"index": 0, "roadName": "京藏高速", "distanceKm": 10.0, "avgSpeedKmh": 80, "gradePercent": 0.5, "elevationM": 1200, "temperatureC": 25, "windSpeedKmh": 10, "windDirDeg": None, "windDirText": "", "windAffects": False, "humidityPct": 40, "roadLevel": "highway", "durationH": 0.125, "massKg": 49000, "gainM": 10, "stopCount": 0, "stopSecondsPer": 30},
    {"index": 1, "roadName": "京藏高速上坡", "distanceKm": 8.0, "avgSpeedKmh": 65, "gradePercent": 3.0, "elevationM": 1500, "temperatureC": 22, "windSpeedKmh": 8, "windDirDeg": None, "windDirText": "", "windAffects": False, "humidityPct": 45, "roadLevel": "highway", "durationH": 0.123, "massKg": 49000, "gainM": 240, "stopCount": 0, "stopSecondsPer": 30},
    {"index": 2, "roadName": "京藏高速下坡", "distanceKm": 6.0, "avgSpeedKmh": 75, "gradePercent": -2.0, "elevationM": 1300, "temperatureC": 20, "windSpeedKmh": 6, "windDirDeg": None, "windDirText": "", "windAffects": False, "humidityPct": 50, "roadLevel": "highway", "durationH": 0.08, "massKg": 49000, "gainM": 0, "stopCount": 0, "stopSecondsPer": 30},
    {"index": 3, "roadName": "国道平路", "distanceKm": 5.0, "avgSpeedKmh": 50, "gradePercent": 0.0, "elevationM": 500, "temperatureC": 28, "windSpeedKmh": 12, "windDirDeg": None, "windDirText": "", "windAffects": False, "humidityPct": 55, "roadLevel": "national", "durationH": 0.1, "massKg": 30000, "gainM": 0, "stopCount": 1, "stopSecondsPer": 30},
    {"index": 4, "roadName": "城市道路", "distanceKm": 3.0, "avgSpeedKmh": 30, "gradePercent": 0.0, "elevationM": 60, "temperatureC": 32, "windSpeedKmh": 5, "windDirDeg": None, "windDirText": "", "windAffects": False, "humidityPct": 60, "roadLevel": "city", "durationH": 0.1, "massKg": 30000, "gainM": 0, "stopCount": 5, "stopSecondsPer": 30},
    {"index": 5, "roadName": "高速拥堵", "distanceKm": 4.0, "avgSpeedKmh": 25, "gradePercent": 0.0, "elevationM": 100, "temperatureC": 26, "windSpeedKmh": 5, "windDirDeg": None, "windDirText": "", "windAffects": False, "humidityPct": 50, "roadLevel": "highway", "durationH": 0.16, "massKg": 30000, "gainM": 0, "stopCount": 8, "stopSecondsPer": 45},
    {"index": 6, "roadName": "山区爬坡", "distanceKm": 7.0, "avgSpeedKmh": 40, "gradePercent": 5.0, "elevationM": 1800, "temperatureC": 15, "windSpeedKmh": 15, "windDirDeg": None, "windDirText": "", "windAffects": False, "humidityPct": 65, "roadLevel": "county", "durationH": 0.175, "massKg": 49000, "gainM": 350, "stopCount": 0, "stopSecondsPer": 30},
    {"index": 7, "roadName": "省道平路", "distanceKm": 6.0, "avgSpeedKmh": 55, "gradePercent": 0.5, "elevationM": 300, "temperatureC": 24, "windSpeedKmh": 7, "windDirDeg": None, "windDirText": "", "windAffects": False, "humidityPct": 45, "roadLevel": "provincial", "durationH": 0.109, "massKg": 30000, "gainM": 30, "stopCount": 1, "stopSecondsPer": 30},
]

REQUIRED_META = ['id', 'name']


# ---------------- meta 校验 ----------------
def validate_meta(meta, dir_id=None):
    errors = []
    for k in REQUIRED_META:
        if not meta.get(k):
            errors.append(f'缺少必填字段 {k}')
    if dir_id and meta.get('id') != dir_id:
        errors.append(f'meta.id({meta.get("id")!r}) 与目录名({dir_id!r})不一致')
    return errors


def load_meta(model_id):
    d = os.path.join(MODELS_DIR, model_id)
    mp = os.path.join(d, 'meta.json')
    if not os.path.exists(mp):
        return None, f'模型 {model_id} 不存在（缺 meta.json）'
    try:
        with open(mp, encoding='utf-8') as f:
            meta = json.load(f)
    except Exception as e:
        return None, f'meta.json 解析失败: {e}'
    errs = validate_meta(meta, model_id)
    if errs:
        return None, '；'.join(errs)
    return meta, None


def list_models():
    out = []
    for mid, m in BUILTIN_MODELS.items():
        out.append({'id': mid, 'valid': True, 'builtin': True, 'name': m['name'], 'version': m.get('version')})
    if not os.path.isdir(MODELS_DIR):
        return out
    for name in sorted(os.listdir(MODELS_DIR)):
        d = os.path.join(MODELS_DIR, name)
        if not os.path.isdir(d):
            continue
        meta, err = load_meta(name)
        if err:
            out.append({'id': name, 'valid': False, 'error': err})
        else:
            out.append({'id': name, 'valid': True, 'name': meta.get('name'), 'version': meta.get('version')})
    return out


# ---------------- 统一调用（唯一入口：predict.py, stdin/stdout JSON） ----------------
def _run_script(script, cwd, segments, timeout=TIMEOUT_S):
    payload = json.dumps({'segments': segments}, ensure_ascii=False)
    try:
        proc = subprocess.run(
            [sys.executable, script], input=payload, capture_output=True,
            text=True, timeout=timeout, cwd=cwd, encoding='utf-8', errors='replace',
        )
    except subprocess.TimeoutExpired:
        return None, f'模型执行超时（>{timeout}s）'
    if proc.returncode != 0:
        return None, f'模型退出码 {proc.returncode}: {proc.stderr[:300]}'
    try:
        out = json.loads(proc.stdout)
    except Exception as e:
        return None, f'输出不是合法 JSON: {e}（stdout 前 200 字: {proc.stdout[:200]!r}）'
    rows, err = normalize_output(out, len(segments))
    if err:
        return None, err
    return validate_h2(rows, segments)


def run_model(model_id, segments, timeout=TIMEOUT_S):
    """喂 segments → 调 predict.py → 校验输出 → 返回 [{index, h2_kg}, ...]"""
    if model_id in BUILTIN_MODELS:
        b = BUILTIN_MODELS[model_id]
        script = os.path.join(PROJECT_ROOT, b['script'])
        cwd = os.path.join(PROJECT_ROOT, 'ml')
        return _run_script(script, cwd, segments, timeout)
    meta, err = load_meta(model_id)
    if err:
        return None, err
    d = os.path.join(MODELS_DIR, model_id)
    script = os.path.join(d, ENTRY)
    if not os.path.exists(script):
        return None, f'缺少入口脚本 {ENTRY}'
    return _run_script(script, d, segments)


def normalize_output(raw, n):
    """把各种可能的输出形状统一成 [{index, h2_kg}...]，顺序对应输入。"""
    segs = None
    if isinstance(raw, dict):
        if 'segments' in raw:
            segs = raw['segments']
        elif 'h2_kg' in raw and isinstance(raw['h2_kg'], list):
            segs = raw['h2_kg']
    elif isinstance(raw, list):
        segs = raw
    if segs is None:
        return None, '输出缺少 segments/h2_kg 数组'
    rows = []
    for i, s in enumerate(segs):
        if isinstance(s, dict):
            if 'h2_kg' not in s:
                return None, f'第 {i} 段输出缺少 h2_kg'
            rows.append({'index': s.get('index', i), 'h2_kg': s['h2_kg']})
        elif isinstance(s, (int, float)):
            rows.append({'index': i, 'h2_kg': s})
        else:
            return None, f'第 {i} 段输出类型不对: {type(s).__name__}'
    if len(rows) != n:
        return None, f'输出段数({len(rows)})与输入段数({n})不一致'
    return rows, None


def validate_h2(rows, segments):
    """合理性：每段 h2_kg 有限、>=0、且不超上限（按里程的宽松上限，防离谱值）。"""
    vals = []
    for i, r in enumerate(rows):
        x = r['h2_kg']
        if isinstance(x, bool) or not isinstance(x, (int, float)):
            return None, f'第 {i} 段 h2_kg 不是数值: {x!r}'
        if x != x or x in (float('inf'), float('-inf')):
            return None, f'第 {i} 段 h2_kg 非法(NaN/Inf)'
        if x < 0:
            return None, f'第 {i} 段 h2_kg 为负: {x}'
        dist = segments[i].get('distanceKm') or 1.0
        cap = 0.6 * dist  # 60 kg/100km，极宽松上限，只挡明显离谱
        if x > cap:
            return None, f'第 {i} 段 h2_kg 明显超物理上限: {x} kg（{dist}km 段，上限 {cap:.2f}）'
        vals.append({'index': r['index'], 'h2_kg': x})
    return vals, None


# ---------------- 试工（可用性测试） ----------------
def smoke_test(model_id):
    """用小仿真数据表跑一遍，输出合理即通过。"""
    vals, err = run_model(model_id, SMOKE_SEGMENTS)
    if err:
        return False, err
    total = sum(v['h2_kg'] for v in vals)
    km = sum(s['distanceKm'] for s in SMOKE_SEGMENTS)
    return True, f'通过：{len(vals)} 段全部输出合理，合计 {total:.3f} kg / {km:.1f} km'


# ---------------- 导入 ----------------
def import_model(src_dir):
    """导入：读 meta → 校验 → 复制到 data/models/<id> → 试工，通过即注册成功。"""
    src = os.path.abspath(src_dir)
    meta_path = os.path.join(src, 'meta.json')
    if not os.path.exists(meta_path):
        return False, '源目录缺少 meta.json'
    try:
        with open(meta_path, encoding='utf-8') as f:
            meta = json.load(f)
    except Exception as e:
        return False, f'meta.json 解析失败: {e}'
    errs = validate_meta(meta)
    if errs:
        return False, '；'.join(errs)
    if not os.path.exists(os.path.join(src, ENTRY)):
        return False, f'源目录缺少入口脚本 {ENTRY}'
    mid = meta['id']
    if mid in BUILTIN_MODELS:
        return False, f'模型 id {mid} 与内置模型冲突，请换一个 id'
    dst = os.path.join(MODELS_DIR, mid)
    if os.path.exists(dst):
        return False, f'模型 {mid} 已存在（如需覆盖请先删除）'
    shutil.copytree(src, dst)
    ok, msg = smoke_test(mid)
    if not ok:
        shutil.rmtree(dst)
        return False, f'试工未通过，已回滚: {msg}'
    return True, f'模型 {mid} 导入成功（试工{msg}）'


# ---------------- CLI ----------------
def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    cmd = args[0]
    if cmd == 'list':
        for m in list_models():
            tag = '内置' if m.get('builtin') else '导入'
            if m['valid']:
                print(f"  [{tag}] {m['id']}  {m['name']}  v{m.get('version','?')}")
            else:
                print(f"  ✗ {m['id']}  （无效: {m['error']}）")
    elif cmd == 'smoke' and len(args) >= 2:
        ok, msg = smoke_test(args[1])
        print(('✅ ' if ok else '❌ ') + msg)
    elif cmd == 'run' and len(args) >= 3:
        with open(args[2], encoding='utf-8') as f:
            inp = json.load(f)
        segs = inp.get('segments', inp if isinstance(inp, list) else [])
        vals, err = run_model(args[1], segs)
        if err:
            print('❌ ' + err)
        else:
            print(json.dumps({'ok': True, 'segments': vals}, ensure_ascii=False))
    elif cmd == 'import' and len(args) >= 2:
        ok, msg = import_model(args[1])
        print(('✅ ' if ok else '❌ ') + msg)
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
