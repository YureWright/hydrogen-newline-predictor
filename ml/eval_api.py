# -*- coding: utf-8 -*-
"""评测集 API（stdin JSON -> stdout JSON），供 Node 后端调用

输入: {"op":"list"|"create"|"append"|"leaderboard"|"download", ...}
输出: {"ok":true, ...} 或 {"ok":false,"msg":...}
"""
import sys, os, json, tempfile

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eval_protocol as ep


def _write_csv(csv_text):
    """把 CSV 文本写到临时文件（保留 BOM/编码），返回路径。"""
    tmp = tempfile.mktemp(suffix='.csv')
    data = csv_text.encode('utf-8')
    if not data.startswith(b'\xef\xbb\xbf'):
        data = b'\xef\xbb\xbf' + data
    with open(tmp, 'wb') as f:
        f.write(data)
    return tmp


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw or '{}')
    except Exception as e:
        print(json.dumps({'ok': False, 'msg': f'请求 JSON 解析失败: {e}'}, ensure_ascii=False)); return
    op = req.get('op')
    tmp = None
    try:
        if op == 'list':
            print(json.dumps({'ok': True, 'evalsets': ep.list_evalsets()}, ensure_ascii=False))
        elif op == 'create':
            tmp = _write_csv(req.get('csv', ''))
            ok, msg = ep.create_evalset(req.get('id',''), req.get('name',''), tmp, req.get('source',''))
            print(json.dumps({'ok': ok, 'msg': msg}, ensure_ascii=False))
        elif op == 'append':
            tmp = _write_csv(req.get('csv', ''))
            ok, msg = ep.append_evalset(req.get('id',''), tmp)
            print(json.dumps({'ok': ok, 'msg': msg}, ensure_ascii=False))
        elif op == 'leaderboard':
            rows = ep.leaderboard(req.get('id',''))
            print(json.dumps({'ok': True, 'rows': rows}, ensure_ascii=False))
        elif op == 'download':
            p = ep._csv_path(req.get('id',''))
            if os.path.exists(p):
                with open(p, encoding='utf-8-sig') as f:
                    print(json.dumps({'ok': True, 'csv': f.read()}, ensure_ascii=False))
            else:
                print(json.dumps({'ok': False, 'msg': '评测集不存在'}, ensure_ascii=False))
        else:
            print(json.dumps({'ok': False, 'msg': f'未知 op: {op}'}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'msg': f'服务端错误: {e}'}, ensure_ascii=False))
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)


if __name__ == '__main__':
    main()
