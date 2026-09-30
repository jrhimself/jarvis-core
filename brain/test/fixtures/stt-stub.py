"""
Stands in for stt/server.py in the tests: the same frames, no model.

Each request is answered with how much audio it held and in which language, so
a test can see what was read and how long it was: "heard 1820ms en".
"""

import base64
import json
import struct
import sys

out = sys.stdout.buffer


def frame(kind, rid, payload=b""):
    out.write(kind + struct.pack(">II", rid, len(payload)) + payload)
    out.flush()


frame(b"R", 0)

for line in sys.stdin:
    request = json.loads(line)
    milliseconds = len(base64.b64decode(request["audio"])) // 32
    frame(b"A", request["id"], f'heard {milliseconds}ms {request["lang"]}'.encode("utf-8"))
    frame(b"D", request["id"])
