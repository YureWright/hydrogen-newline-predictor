# -*- coding: utf-8 -*-
"""评测集协议 + 排行榜引擎（配合 ml/model_protocol.py 使用）

评测集 = data/evalsets/<eval_id>/
  meta.json   {id, name, description, source, created, n_rows}
  data.csv    每行一条"段"记录：标准变量 + h2_kg（真实氢耗，kg/段）

必须列（与模型输入一致，缺一不可）：
  distanceKm, avgSpeedKmh, gradePercent, elevationM, temperatureC,
  windSpeedKmh, humidityPct, roadLevel, durationH, massKg, h2_kg
可选列（有则用、无则给默认）：
  windDirDeg, windDirText, windAffects, gainM, stopCount, stopSecondsPer,
  vehicle, time

用法：
  python eval_protocol.py list
  python eval_protocol.py create <id> <name> <data.csv> <来源说明>
  python eval_protocol.py append <id> <data.csv>
  python eval_protocol.py eval <model_id> <eval_id>
  python eval_protocol.py leaderboard <eval_id>
  python eval_protocol.py download <eval_id>
"""
import csv
import io
import json
import os
import sys
from datetime import datetime

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)
EVALSETS_DIR = os.path.join(PROJECT_ROOT, 'data', 'evalsets')
os.makedirs(EVALSETS_DIR, exist_ok=True)

REQUIRED_COLS = [
    'distanceKm', 'avgSpeedKmh', 'gradePercent', 'elevationM', 'temperatureC',
    'windSpeedKmh', 'humidityPct', 'roadLevel', 'durationH', 'massKg', 'h2_kg',
]
OPTIONAL_COLS = [
    'windDirDeg', 'windDirText', 'windAffects', 'gainM', 'stopCount',
    'stopSecondsPer', 'vehicle', 'time',
]
OPTIONAL_DEFAULTS = {
    'windDirDeg': None, 'windDirText': '', 'windAffects': False,
    'gainM': 0, 'stopCount': 0, 'stopSecondsPer': 30, 'vehicle': '', 'time': '',
}


# ---------------- 评测集管理 ----------------
def _meta_path(eval_id):
    return os.path.join(EVALSETS_DIR, eval_id, 'meta.json')


def _csv_path(eval_id):
    return os.path.join(EVALSETS_DIR, eval_id, 'data.csv')


def load_meta(eval_id):
    p = _meta_path(eval_id)
    if not os.path.exists(p):
        return None, f'评测集 {eval_id} 不存在'
    with open(p, encoding='utf-8') as f:
        return json.load(f), None


def list_evalsets():
    out = []
    if not os.path.isdir(EVALSETS_DIR):
        return out
    for name in sorted(os.listdir(EVALSETS_DIR)):
        d = os.path.join(EVALSETS_DIR, name)
        if not os.path.isdir(d):
            continue
        meta, err = load_meta(name)
        out.append({'id': name, 'name': meta.get('name') if meta else '?',
                    'n_rows': meta.get('n_rows') if meta else 0,
                    'source': meta.get('source') if meta else ''})
    return out


def _read_csv(csv_path):
    """读 CSV → (header, rows[dict])，UTF-8（容忍 BOM）"""
    with open(csv_path, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        rows = list(reader)
    return header, rows


def _validate_rows(header, rows):
    errs = []
    for c in REQUIRED_COLS:
        if c not in header:
            errs.append(f'缺少必须列 {c}')
    if errs:
        return None, '；'.join(errs)
    # 校验 h2_kg / 数值列有限且>=0；roadLevel 非空
    bad = 0
    for i, r in enumerate(rows):
        try:
            h2 = float(r.get('h2_kg'))
            if h2 != h2 or h2 < 0:
                bad += 1
                continue
            float(r.get('distanceKm', 0)); float(r.get('avgSpeedKmh', 0))
        except (TypeError, ValueError):
            bad += 1
        if not str(r.get('roadLevel', '')).strip():
            bad += 1
    if bad:
        return None, f'{bad} 行数据非法（h2_kg/数值列/roadLevel 缺失或异常）'
    return rows, None


def create_evalset(eval_id, name, csv_path, source=''):
    dst = os.path.join(EVALSETS_DIR, eval_id)
    if os.path.exists(dst):
        return False, f'评测集 {eval_id} 已存在（如需重建先删除）'
    header, rows = _read_csv(csv_path)
    rows, err = _validate_rows(header, rows)
    if err:
        return False, '校验失败: ' + err
    os.makedirs(dst)
    # 落盘 data.csv（只保留标准+可选列，统一顺序）
    out_cols = REQUIRED_COLS + [c for c in OPTIONAL_COLS if c in header]
    with io.open(os.path.join(dst, 'data.csv'), 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=out_cols, extrasaction='ignore')
        w.writeheader()
        for r in rows:
            row = {c: r.get(c, OPTIONAL_DEFAULTS.get(c, '')) for c in out_cols}
            w.writerow(row)
    meta = {
        'id': eval_id, 'name': name, 'source': source,
        'created': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'n_rows': len(rows), 'columns': out_cols,
    }
    with io.open(os.path.join(dst, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return True, f'评测集 {eval_id} 创建成功：{len(rows)} 行'


def append_evalset(eval_id, csv_path):
    meta, err = load_meta(eval_id)
    if err:
        return False, err
    header, rows = _read_csv(csv_path)
    rows, err = _validate_rows(header, rows)
    if err:
        return False, '校验失败: ' + err
    out_cols = REQUIRED_COLS + [c for c in OPTIONAL_COLS if c in header]
    with io.open(_csv_path(eval_id), 'a', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=out_cols, extrasaction='ignore')
        for r in rows:
            row = {c: r.get(c, OPTIONAL_DEFAULTS.get(c, '')) for c in out_cols}
            w.writerow(row)
    meta['n_rows'] = meta.get('n_rows', 0) + len(rows)
    with io.open(_meta_path(eval_id), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return True, f'追加 {len(rows)} 行，现有共 {meta["n_rows"]} 行'


def load_rows(eval_id):
    """读评测集行 → [{segment字段..., h2_kg}]"""
    meta, err = load_meta(eval_id)
    if err:
        return None, err
    header, rows = _read_csv(_csv_path(eval_id))
    out = []
    for r in rows:
        seg = {c: _to_num(r.get(c)) if c not in ('roadLevel', 'windDirText', 'vehicle', 'time') else r.get(c, '') for c in REQUIRED_COLS[:-1]}
        # 数值化（含 windDirDeg 等可选数值列）
        for c in ('windDirDeg', 'gainM', 'stopCount', 'stopSecondsPer'):
            if c in r:
                seg[c] = _to_num(r.get(c))
        if 'windAffects' in r:
            seg['windAffects'] = str(r.get('windAffects')).lower() in ('1', 'true', 'yes')
        seg['h2_kg'] = float(r['h2_kg'])
        out.append(seg)
    return out, None


def _to_num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# ---------------- 评测 ----------------
def eval_model(model_id, eval_id):
    """跑一个模型对评测集的误差 → metrics dict"""
    from model_protocol import run_model
    rows, err = load_rows(eval_id)
    if err:
        return None, err
    segs = [dict(r) for r in rows]
    preds, err = run_model(model_id, segs, timeout=600)  # 评测可放宽超时（histgb 全量约 1~2 分钟）
    if err:
        return None, f'模型 {model_id} 运行失败: {err}'
    y = [r['h2_kg'] for r in rows]
    p = [v['h2_kg'] for v in preds]
    n = len(y)
    mae = sum(abs(a - b) for a, b in zip(y, p)) / n
    rmse = (sum((a - b) ** 2 for a, b in zip(y, p)) / n) ** 0.5
    ym = sum(y) / n
    ss_tot = sum((a - ym) ** 2 for a in y)
    ss_res = sum((a - b) ** 2 for a, b in zip(y, p))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else float('nan')
    km = sum(r['distanceKm'] for r in rows)
    return {
        'model': model_id, 'n': n, 'total_km': round(km, 1),
        'truth_total_kg': round(sum(y), 3), 'pred_total_kg': round(sum(p), 3),
        'mae_kg': round(mae, 4), 'rmse_kg': round(rmse, 4), 'r2': round(r2, 4),
    }, None


def leaderboard(eval_id):
    """所有模型（内置+导入）在评测集上的排名，每模型一条。"""
    from model_protocol import list_models, BUILTIN_MODELS
    models = list_models()
    out = []
    for m in models:
        if not m['valid']:
            continue
        r, err = eval_model(m['id'], eval_id)
        if err:
            out.append({'model': m['id'], 'name': m.get('name', m['id']), 'error': err})
        else:
            r['name'] = m.get('name', m['id'])
            r['builtin'] = m.get('builtin', False)
            out.append(r)
    # 排序：RMSE 升序（有 error 的排最后）
    out.sort(key=lambda x: (x.get('error') is not None, x.get('rmse_kg') if x.get('rmse_kg') is not None else 1e18))
    for rank, r in enumerate(out, 1):
        r['rank'] = rank
    return out


# ---------------- CLI ----------------
def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    cmd = args[0]
    if cmd == 'list':
        for e in list_evalsets():
            print(f"  {e['id']}  {e['name']}  共{e['n_rows']}行  来源: {e.get('source','')}")
    elif cmd == 'create' and len(args) >= 4:
        ok, msg = create_evalset(args[1], args[2], args[3], args[4] if len(args) > 4 else '')
        print(('✅ ' if ok else '❌ ') + msg)
    elif cmd == 'append' and len(args) >= 3:
        ok, msg = append_evalset(args[1], args[2])
        print(('✅ ' if ok else '❌ ') + msg)
    elif cmd == 'eval' and len(args) >= 3:
        r, err = eval_model(args[1], args[2])
        if err:
            print('❌ ' + err)
        else:
            print(json.dumps(r, ensure_ascii=False, indent=2))
    elif cmd == 'leaderboard' and len(args) >= 2:
        rows = leaderboard(args[1])
        print(f"== 排行榜 · 评测集 {args[1]} ==")
        for r in rows:
            if 'error' in r:
                print(f"  {r.get('rank','-')}. {r['name']}  ❌ {r['error']}")
            else:
                print(f"  {r['rank']}. {r['name']}  MAE={r['mae_kg']}kg  RMSE={r['rmse_kg']}kg  R²={r['r2']}  (n={r['n']})")
    elif cmd == 'download' and len(args) >= 2:
        p = _csv_path(args[1])
        if os.path.exists(p):
            print(p)
        else:
            print('❌ 评测集不存在')
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
