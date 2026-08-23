# -*- coding: utf-8 -*-
"""数据回填：原始 60s CSV → DEM 海拔/坡度 + ERA5 历史天气 + 高德道路等级 → _v1/_v2_feat.csv
自动识别编码（车辆1 GBK / 车辆2 UTF-8+BOM）；各源带磁盘缓存，重复运行秒回。"""
import pandas as pd, numpy as np, math, os, sys, time, requests, json, re
from concurrent.futures import ThreadPoolExecutor
# 无代理直连（沙箱代理会拦截 open-meteo；node fetch 直连可用，python 也直连）
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
NO_PROXY_SESSION = requests.Session()
NO_PROXY_SESSION.trust_env = False
NO_PROXY_SESSION.verify = False
def http_get(url, timeout=60):
    return NO_PROXY_SESSION.get(url, timeout=timeout)

print = lambda *a: sys.stdout.write(" ".join(map(str,a))+"\n") or sys.stdout.flush()
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEM_CACHE = os.path.join(ROOT, "data", "dem-cache-python")
WX_CACHE = os.path.join(ROOT, "data", "weather-history-cache")
GEO_CACHE = os.path.join(ROOT, "data", "regeo-cache.json")
os.makedirs(DEM_CACHE, exist_ok=True); os.makedirs(WX_CACHE, exist_ok=True)
AMAP_KEY = os.environ.get("AMAP_KEY", "")
def read_csv_any(f):
    for enc in ["utf-8-sig", "utf-8", "gbk"]:
        try: return pd.read_csv(f, encoding=enc)
        except Exception: continue
    raise IOError("无法读取: " + f)

# ---------- DEM 海拔/坡度 ----------
def tileXY(lng, lat, z):
    n = 2**z
    x = int((lng+180)/360*n)
    y = int((1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*n)
    return x, y, n
def get_tile(x, y, z):
    path = f"{DEM_CACHE}/{z}_{x}_{y}.png"
    if not os.path.exists(path):
        url = f"https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"
        for a in range(3):
            try:
                r = http_get(url, timeout=30)
                if r.status_code == 200:
                    open(path, "wb").write(r.content); return path
            except Exception: time.sleep(1)
        return None
    return path
def elev_at(lng, lat, z=11):
    from PIL import Image
    x, y, n = tileXY(lng, lat, z)
    p = get_tile(x, y, z)
    if p is None: return float("nan")
    img = Image.open(p).convert("RGB")
    px = (lng - (-180 + x*360.0/n)) / (360.0/n) * 256
    phi = math.radians(lat)
    merc = math.log(math.tan(math.pi/4 + phi/2))/math.pi
    py = (0.5 - merc/2)*n*256/n - y*256
    px = max(0, min(255, px)); py = max(0, min(255, py))
    r, g, b = img.getpixel((min(255, max(0, int(px))), min(255, max(0, int(py)))))
    return (r*256 + g + b/256.0) - 32768.0
def add_dem(df, tag):
    print("[%s] DEM 海拔..." % tag)
    lat = df["lat_纬度"].values/1e6; lon = df["lon_经度"].values/1e6
    elev = []
    for i, (la, lo) in enumerate(zip(lat, lon)):
        elev.append(elev_at(float(lo), float(la)))
        if (i+1) % 300 == 0: print("  %d/%d" % (i+1, len(df)))
    df["elev_m"] = np.round(elev, 1)
    e = df["elev_m"].values
    # 坡度：相邻 60s 点（同一行程，时间差<=120s）海拔差/水平距离
    t = pd.to_datetime(df.iloc[:, 0], errors="coerce").values
    dt = np.full(len(df), 0.0); dt[1:] = np.diff(t).astype("timedelta64[s]").astype(float)
    R = 6371000.0
    d = np.zeros(len(df))
    p1 = np.radians(lat[:-1]); p2 = np.radians(lat[1:])
    dp = np.radians(lat[1:]-lat[:-1]); dl = np.radians(lon[1:]-lon[:-1])
    a = np.sin(dp/2)**2 + np.cos(p1)*np.cos(p2)*np.sin(dl/2)**2
    d[1:] = 2*R*np.arcsin(np.sqrt(a))
    grade = np.zeros(len(df))
    for i in range(1, len(df)):
        if dt[i] <= 120 and d[i] > 10 and np.isfinite(e[i]) and np.isfinite(e[i-1]):
            grade[i] = (e[i]-e[i-1]) / (d[i]/1000.0) / 10.0
    # 坡度裁剪：重卡最大爬坡约 15%（公路极限 8%），±25% 已覆盖陡坡，更大值多为相邻点间距过小的数值噪声
    grade = np.clip(grade, -25, 25)
    df["grade_pct"] = np.round(grade, 3)
    fin = np.isfinite(e)
    print("[%s] 海拔 %.0f~%.0f m (有效%.0f%%)" % (tag, np.nanmin(e), np.nanmax(e), fin.mean()*100))
    return df

# ---------- ERA5 历史天气 ----------
def fetch_wx_batch(lats, lons, start, end):
    cache = f"{WX_CACHE}/era5_v2_{start}_{end}_b{len(lats)}.json"
    if os.path.exists(cache):
        return json.load(open(cache, encoding="utf-8"))
    url = ("https://archive-api.open-meteo.com/v1/era5?latitude=%s&longitude=%s"
           "&start_date=%s&end_date=%s&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,relative_humidity_2m,precipitation"
           "&timezone=Asia%%2FShanghai") % (",".join("%.4f"%a for a in lats), ",".join("%.4f"%b for b in lons), start, end)
    for a in range(3):
        try:
            r = http_get(url, timeout=60); j = r.json()
            if isinstance(j, dict) and j.get("error"): raise Exception(j.get("reason"))
            if not isinstance(j, list): raise Exception("bad response")
            json.dump(j, open(cache, "w", encoding="utf-8")); return j
        except Exception as e:
            print("  重试", a, e); time.sleep(2)
    return None
def add_weather(df, tag, start, end):
    print("[%s] ERA5 历史天气 %s~%s..." % (tag, start, end))
    lats = df["lat_纬度"].values/1e6; lons = df["lon_经度"].values/1e6
    gmap = {}
    for la, lo in zip(lats, lons):
        k = "%d_%d" % (round(la*4), round(lo*4))
        gmap.setdefault(k, (round(la*4)/4, round(lo*4)/4))
    items = list(gmap.items()); result = {}
    for i in range(0, len(items), 100):
        chunk = items[i:i+100]
        glats = [c[1][0] for c in chunk]; glons = [c[1][1] for c in chunk]
        j = fetch_wx_batch(glats, glons, start, end)
        if j:
            for obj in j:
                la, lo = obj["latitude"], obj["longitude"]
                k = "%d_%d" % (round(la*4), round(lo*4))
                h = obj.get("hourly")
                if h:
                    result[k] = {"time": np.array(h["time"], dtype="datetime64[ns]"),
                                 "t": np.array(h["temperature_2m"], float),
                                 "w": np.array(h["wind_speed_10m"], float),
                                 "wd": np.array(h["wind_direction_10m"], float),
                                 "h": np.array(h["relative_humidity_2m"], float),
                                 "p": np.array(h["precipitation"], float)}
        print("  批 %d/%d" % (i//100+1, (len(items)+99)//100))
        time.sleep(0.4)
    times = pd.to_datetime(df.iloc[:, 0], errors="coerce")
    T, W, WD, H, P = [], [], [], [], []
    for la, lo, ts in zip(lats, lons, times):
        arr = result.get("%d_%d" % (round(la*4), round(lo*4)))
        if arr is None or pd.isna(ts):
            T.append(np.nan); W.append(np.nan); WD.append(np.nan); H.append(np.nan); P.append(np.nan); continue
        idx = int(np.abs(arr["time"] - np.datetime64(ts, "ns")).argmin())
        T.append(arr["t"][idx]); W.append(arr["w"][idx]); WD.append(arr["wd"][idx]); H.append(arr["h"][idx]); P.append(arr["p"][idx])
    df["temp_c"] = np.round(T, 1); df["wind_kmh"] = np.round(W, 1)
    df["wind_dir_deg"] = np.round(WD, 0)
    df["hum_pct"] = np.round(H, 0); df["precip_mm"] = np.round(P, 2)
    print("[%s] 温度 %.1f~%.1f ℃ 覆盖 %.0f%%" % (tag, np.nanmin(T), np.nanmax(T), np.isfinite(T).mean()*100))
    return df

# ---------- 风向组件：航向 + 纵/横风分量 ----------
def bearing_deg(lat1, lon1, lat2, lon2):
    """两点大圆初始方位角（0~360，北=0 顺时针），与前端 segHeadingDeg 口径一致"""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1)*math.sin(p2) - math.sin(p1)*math.cos(p2)*math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360

def add_wind_components(df):
    """每帧航向（当前点→下一点），把风速分解为相对车头的：
    纵向 wind_par_kmh = w·cos(φ−θ)（逆风为正/顺风为负）、
    横向 wind_perp_kmh = w·sin(φ−θ)（侧风，左/右无方向只计大小）。
    约定与物理模型 windDirDeg/headingDeg 一致：φ=风来向、θ=车头航向、北=0 顺时针。"""
    lat = df["lat_纬度"].values/1e6; lon = df["lon_经度"].values/1e6
    w = df["wind_kmh"].values.astype(float); wd = df["wind_dir_deg"].values.astype(float)
    n = len(df)
    head = np.full(n, np.nan)
    for i in range(n-1):
        head[i] = bearing_deg(lat[i], lon[i], lat[i+1], lon[i+1])
    if n > 1: head[-1] = head[-2]
    phi = np.radians(np.where(np.isfinite(wd), wd, 0.0))
    th = np.radians(np.where(np.isfinite(head), head, 0.0))
    par = w * np.cos(phi - th)
    perp = w * np.sin(phi - th)
    df["wind_par_kmh"] = np.round(np.where(np.isfinite(par), par, 0.0), 1)
    df["wind_perp_kmh"] = np.round(np.where(np.isfinite(perp), perp, 0.0), 1)
    return df

# ---------- 高德 regeo：道路等级/行政区 ----------
LV_RULES = [("高速", "highway"), ("国道", "national"), ("省道", "provincial"), ("县道", "county"), ("乡道", "county"),
                (r"^G\d{3}(?!\d)", "national"), (r"^G\d", "highway"), (r"^S\d", "provincial"), (r"^X\d", "county"),
                ("快速", "expressway"), ("高架", "expressway"), ("环", "expressway"), ("大道", "city"), ("路", "city"), ("街", "city")]
def road_level(name):
    s = str(name or "")
    for pat, lv in LV_RULES:
        if re.search(pat, s): return lv
    return "other"
def regeo_cache():
    try: return json.load(open(GEO_CACHE, encoding="utf-8"))
    except: return {}
def add_geo(df, tag):
    print("[%s] 高德 regeo..." % tag)
    lat = df["lat_纬度"].values/1e6; lon = df["lon_经度"].values/1e6
    grids = {}
    for la, lo in zip(lat, lon):
        g = "%.3f_%.3f" % (round(la, 3), round(lo, 3))
        grids.setdefault(g, (round(la, 3), round(lo, 3)))
    cache = regeo_cache(); glist = list(grids.items())
    def work(item):
        g, (glat, glon) = item
        if g in cache: return g, cache[g]
        try:
            url = "https://restapi.amap.com/v3/geocode/regeo?location=%.6f,%.6f&extensions=all&key=%s" % (glon, glat, AMAP_KEY)
            j = http_get(url, timeout=20).json()
            rc = (j or {}).get("regeocode") or {}; ac = rc.get("addressComponent") or {}
            roads = rc.get("roads") or []
            nearest = ""
            for r in sorted(roads, key=lambda x: float(x.get("distance") or 9999)):
                if r.get("name"): nearest = r["name"]; break
            out = {"province": str(ac.get("province") or ""), "city": str(ac.get("city") or ac.get("district") or ""),
                   "road": nearest, "level": road_level(nearest)}
            return g, out
        except Exception:
            return g, {"province": "", "city": "", "road": "", "level": "other"}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, (g, r) in enumerate(ex.map(work, glist)):
            cache[g] = r
            if (i+1) % 100 == 0: print("  %d/%d" % (i+1, len(glist)))
    json.dump(cache, open(GEO_CACHE, "w", encoding="utf-8"))
    prov = []; city = []; lv = []
    for la, lo in zip(lat, lon):
        r = cache.get("%.3f_%.3f" % (round(la, 3), round(lo, 3))) or {"province": "", "city": "", "level": "other"}
        prov.append(r["province"]); city.append(r["city"]); lv.append(r["level"])
    df["province"] = prov; df["city"] = city; df["road_level"] = lv
    print("[%s] 等级分布: %s" % (tag, {k: lv.count(k) for k in set(lv)}))
    return df

if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    jobs = {"1": ("车辆1清洗_聚合60s_行驶窗口.csv", "_v1_feat.csv", "车1", "2026-08-01", "2026-08-18"),
            "2": ("车辆2清洗_聚合60s_行驶窗口.csv", "_v2_feat.csv", "车2", "2026-08-08", "2026-08-11")}
    for k, (src, out, tag, ws, we) in jobs.items():
        if only and only != k: continue
        src = os.path.join(ROOT, src); out = os.path.join(ROOT, out)
        print("===== %s: %s → %s =====" % (tag, os.path.basename(src), out))
        df = read_csv_any(src)
        df = add_dem(df, tag)
        df = add_weather(df, tag, ws, we)
        df = add_wind_components(df)
        if AMAP_KEY: df = add_geo(df, tag)
        else: print("[%s] 未配置 AMAP_KEY，跳过道路等级回填" % tag)
        df.to_csv(out, index=False, encoding="utf-8-sig")
        print("[%s] 已保存 %s (%d 行)" % (tag, out, len(df)))
