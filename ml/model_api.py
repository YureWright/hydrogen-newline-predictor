# -*- coding: utf-8 -*-
"""模型 API（stdin JSON -> stdout JSON），供 Node 后端调用

输入: {"op":"list"|"import_zip"|"smoke", ...}
输出: {"ok":true, ...} 或 {"ok":false,"msg":...}
"""
import sys, os, json, base64, tempfile

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model_protocol as mp


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw or '{}')
    except Exception as e:
        print(json.dumps({'ok': False, 'msg': f'请求 JSON 解析失败: {e}'}, ensure_ascii=False)); return
    op = req.get('op')
    try:
        if op == 'list':
            print(json.dumps({'ok': True, 'models': mp.list_models()}, ensure_ascii=False))
        elif op == 'smoke':
            mid = req.get('model_id', '')
            ok, msg = mp.smoke_test(mid)
            print(json.dumps({'ok': ok, 'msg': msg}, ensure_ascii=False))
        elif op == 'import_zip':
            b64 = req.get('data', '')
            if not b64:
                print(json.dumps({'ok': False, 'msg': '缺少 zip 内容(base64)'}, ensure_ascii=False)); return
            tmp = tempfile.mktemp(suffix='.zip')
            try:
                with open(tmp, 'wb') as f:
                    f.write(base64.b64decode(b64))
                ok, msg = mp.import_model_zip(tmp, max_size_mb=req.get('max_size_mb', 50), allow_env=False)
                print(json.dumps({'ok': ok, 'msg': msg}, ensure_ascii=False))
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
        else:
            print(json.dumps({'ok': False, 'msg': f'未知 op: {op}'}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'msg': f'服务端错误: {e}'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
