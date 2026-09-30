"""
Stands in for piper/server.py in the tests: the same frames, no model.

Each request is answered with two audio frames -- the text itself as bytes, so
a test can see what was read and in what order -- and a done. The text "CRASH"
kills the process; "FAIL" is an error frame; "SLOW" waits before answering.
"""

import json
import struct
import sys
import time

out = sys.stdout.buffer


def frame(kind, rid, payload=b""):
    out.write(kind + struct.pack(">II", rid, len(payload)) + payload)
    out.flush()


if "--no-ready" not in sys.argv:
    frame(b"R", 0)

for line in sys.stdin:
    request = json.loads(line)
    text = request["text"]
    if text.startswith("CRASH"):
        sys.exit(3)
    if text.startswith("FAIL"):
        frame(b"E", request["id"], b"no such voice")
        continue
    if text.startswith("SLOW"):
        time.sleep(0.3)
    body = f'{request["voice"]}|{text}'.encode("utf-8")
    frame(b"A", request["id"], body[:4])
    frame(b"A", request["id"], body[4:])
    frame(b"D", request["id"])
