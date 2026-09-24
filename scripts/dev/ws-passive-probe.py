#!/usr/bin/env python3
"""Passive 60s WS probe against jarvis-core. Redacts personal content."""
import json, ssl, sys, time, hashlib
from collections import Counter, OrderedDict

try:
    import websocket  # websocket-client
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "-q", "websocket-client"])
    import websocket

URL = sys.argv[1] if len(sys.argv) > 1 else "wss://127.0.0.1:443/ws"
DURATION = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0

SENSITIVE_KEYS = {
    "text", "label", "detail", "title", "body", "summary", "condition",
    "from", "subject", "message", "name", "address", "email", "phone",
    "value", "topicLabel", "reason", "location", "city", "street",
}

def redact(obj, depth=0):
    if depth > 8:
        return "..."
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            lk = str(k).lower()
            if lk in SENSITIVE_KEYS or "name" in lk or "email" in lk or "phone" in lk or "addr" in lk:
                if isinstance(v, str):
                    out[k] = f"<str len={len(v)}>"
                elif isinstance(v, (int, float)):
                    out[k] = "<num>"
                elif isinstance(v, list):
                    out[k] = f"<list n={len(v)}>"
                elif isinstance(v, dict):
                    out[k] = {kk: ("..." if not isinstance(vv, (dict, list)) else type(vv).__name__) for kk, vv in list(vv.items())[:12]}
                else:
                    out[k] = type(v).__name__
            elif lk in ("data",) and isinstance(v, str) and len(v) > 64:
                out[k] = f"<b64 len={len(v)} sha16={hashlib.sha256(v.encode()).hexdigest()[:16]}>"
            else:
                out[k] = redact(v, depth+1)
        return out
    if isinstance(obj, list):
        if len(obj) > 6:
            return [redact(x, depth+1) for x in obj[:4]] + [f"...+{len(obj)-4} more"]
        return [redact(x, depth+1) for x in obj]
    if isinstance(obj, str) and len(obj) > 120:
        return f"<str len={len(obj)}>"
    return obj

counts = Counter()
samples = OrderedDict()
timeline = []
t0 = time.time()

def on_message(ws, message):
    try:
        m = json.loads(message)
    except Exception:
        counts["<non-json>"] += 1
        return
    kind = m.get("kind", "<no-kind>")
    counts[kind] += 1
    if kind not in samples:
        samples[kind] = redact(m)
    # compact timeline entry
    entry = {"t": round(time.time()-t0, 3), "kind": kind}
    for k in ("panel", "turnId", "id", "topic", "source", "stage", "available", "briefing", "expectsReply", "durationMs", "final", "opening", "seq", "lang", "sessionId"):
        if k in m:
            entry[k] = m[k]
    if "payload" in m and isinstance(m["payload"], dict):
        entry["payloadType"] = m["payload"].get("type")
        entry["payloadKeys"] = sorted(m["payload"].keys())
    if "cue" in m:
        entry["hasCue"] = True
        if isinstance(m["cue"], dict):
            entry["cueKeys"] = sorted(m["cue"].keys())
    if "usage" in m and isinstance(m["usage"], dict):
        entry["usageKeys"] = sorted(m["usage"].keys())
        entry["usageStatus"] = m["usage"].get("status")
    if "slots" in m and isinstance(m["slots"], list):
        entry["slotTopics"] = [s.get("topic") for s in m["slots"] if isinstance(s, dict)]
    if "tiles" in m and isinstance(m["tiles"], list):
        entry["tileCount"] = len(m["tiles"])
    if "checks" in m and isinstance(m["checks"], list):
        entry["checkCount"] = len(m["checks"])
        entry["checkServers"] = [c.get("server") for c in m["checks"] if isinstance(c, dict)]
    if "metrics" in m and isinstance(m["metrics"], dict):
        entry["metricKeys"] = sorted(m["metrics"].keys())
    if "text" in m and isinstance(m["text"], str):
        entry["textLen"] = len(m["text"])
    timeline.append(entry)

def on_error(ws, err):
    print("WS_ERROR", repr(err), file=sys.stderr)

def on_open(ws):
    print(f"OPEN {URL} listening {DURATION}s", flush=True)

def on_close(ws, *a):
    print("CLOSE", a, flush=True)

ws = websocket.WebSocketApp(URL, on_message=on_message, on_error=on_error, on_open=on_open, on_close=on_close)
import threading
def stopper():
    time.sleep(DURATION)
    try: ws.close()
    except Exception: pass
threading.Thread(target=stopper, daemon=True).start()
ws.run_forever(sslopt={"cert_reqs": ssl.CERT_NONE, "check_hostname": False})

print("=== COUNTS ===")
for k, v in counts.most_common():
    print(f"{k}: {v}")
print("=== SAMPLES (redacted) ===")
print(json.dumps(samples, indent=2, ensure_ascii=False))
print("=== TIMELINE ===")
print(json.dumps(timeline, indent=2, ensure_ascii=False))
