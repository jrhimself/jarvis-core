#!/usr/bin/env python3
"""Send one Dutch weather utterance; log turn until done (max 120s). No audio playback."""
import json, ssl, sys, time, uuid, hashlib
from collections import OrderedDict

try:
    import websocket
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "-q", "websocket-client"])
    import websocket

URL = sys.argv[1] if len(sys.argv) > 1 else "wss://127.0.0.1:443/ws"
TEXT = sys.argv[2] if len(sys.argv) > 2 else "Wat voor weer wordt het vandaag?"
MAX_S = float(sys.argv[3]) if len(sys.argv) > 3 else 120.0

turn_id = str(uuid.uuid4())
events = []
t0 = time.time()
done = {"flag": False}
got_usage = {"flag": False}
session = {"ready": False}

def summarize(m):
    kind = m.get("kind")
    e = {"t": round(time.time()-t0, 3), "kind": kind}
    for k in ("panel", "turnId", "id", "topic", "source", "stage", "available", "briefing",
              "expectsReply", "durationMs", "final", "opening", "seq", "lang", "sessionId", "label"):
        if k in m:
            v = m[k]
            if k == "label" and isinstance(v, str):
                e[k] = f"<str len={len(v)}>"
            else:
                e[k] = v
    if "cue" in m:
        e["hasCue"] = True
        if isinstance(m["cue"], dict):
            e["cueKeys"] = sorted(m["cue"].keys())
            # shape only
            for ck, cv in m["cue"].items():
                if isinstance(cv, str):
                    e[f"cue.{ck}"] = f"<str len={len(cv)}>"
                else:
                    e[f"cue.{ck}"] = cv
    if "payload" in m and isinstance(m["payload"], dict):
        e["payloadType"] = m["payload"].get("type")
        e["payloadKeys"] = sorted(m["payload"].keys())
        if m["payload"].get("type") == "weather":
            days = m["payload"].get("days") or []
            e["weatherDays"] = len(days) if isinstance(days, list) else None
            e["hasNow"] = "now" in m["payload"]
            e["hasUnits"] = "units" in m["payload"]
    if "usage" in m and isinstance(m["usage"], dict):
        got_usage["flag"] = True
        u = m["usage"]
        e["usage"] = {
            "status": u.get("status"),
            "binding": u.get("binding"),
            "keys": sorted(u.keys()),
            "sessionUtil": (u.get("session") or {}).get("utilization") if isinstance(u.get("session"), dict) else None,
            "weekUtil": (u.get("week") or {}).get("utilization") if isinstance(u.get("week"), dict) else None,
        }
    if "tiles" in m:
        e["tileCount"] = len(m["tiles"]) if isinstance(m["tiles"], list) else None
    if "text" in m and isinstance(m["text"], str):
        e["textLen"] = len(m["text"])
    if "data" in m and isinstance(m["data"], str):
        e["dataLen"] = len(m["data"])
    if "message" in m and isinstance(m["message"], str):
        e["messageLen"] = len(m["message"])
    return e

def on_message(ws, message):
    try:
        m = json.loads(message)
    except Exception:
        return
    e = summarize(m)
    events.append(e)
    print(json.dumps(e, ensure_ascii=False), flush=True)
    kind = m.get("kind")
    if kind == "ready":
        session["ready"] = True
        # wait a beat for usage/desk then send utterance
        def send_utt():
            time.sleep(1.5)
            msg = {"kind": "utterance", "text": TEXT, "turnId": turn_id}
            print(json.dumps({"t": round(time.time()-t0,3), "kind": "_client_send", "payload": {"kind":"utterance","turnId":turn_id,"textLen":len(TEXT)}}, ensure_ascii=False), flush=True)
            ws.send(json.dumps(msg))
        import threading
        threading.Thread(target=send_utt, daemon=True).start()
    if kind == "done" and m.get("turnId") == turn_id:
        done["flag"] = True
        # give a moment for unfocus after done
        def closer():
            time.sleep(2.0)
            try: ws.close()
            except Exception: pass
        import threading
        threading.Thread(target=closer, daemon=True).start()
    if kind == "error" and m.get("turnId") == turn_id:
        done["flag"] = True
        try: ws.close()
        except Exception: pass

def on_error(ws, err):
    print("WS_ERROR", repr(err), file=sys.stderr)

def on_open(ws):
    print(json.dumps({"t":0,"kind":"_open","url":URL,"utteranceTurnId":turn_id}), flush=True)

ws = websocket.WebSocketApp(URL, on_message=on_message, on_error=on_error, on_open=on_open)
import threading
def watchdog():
    time.sleep(MAX_S)
    if not done["flag"]:
        print(json.dumps({"t": round(time.time()-t0,3), "kind":"_timeout"}), flush=True)
    try: ws.close()
    except Exception: pass
threading.Thread(target=watchdog, daemon=True).start()
ws.run_forever(sslopt={"cert_reqs": ssl.CERT_NONE, "check_hostname": False})

print("=== SUMMARY ===")
kinds = {}
for e in events:
    kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
print(json.dumps({
    "turnId": turn_id,
    "gotUsageOnConnect": got_usage["flag"],
    "focusEvents": [e for e in events if e["kind"]=="focus"],
    "unfocusEvents": [e for e in events if e["kind"]=="unfocus"],
    "doneEvents": [e for e in events if e["kind"]=="done"],
    "displayEvents": [e for e in events if e["kind"]=="display"],
    "tilesEvents": [{"topic": e.get("topic"), "tileCount": e.get("tileCount")} for e in events if e["kind"]=="tiles"],
    "kindCounts": kinds,
    "eventCount": len(events),
}, indent=2, ensure_ascii=False))
