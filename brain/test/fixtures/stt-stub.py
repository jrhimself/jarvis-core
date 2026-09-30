"""
Stands in for stt/server.py in the tests: the same frames, no model.

Each request is answered with how much audio it held and which language it was
asked for -- "heard 1820ms nl", or "heard 1820ms auto" when it was left to
choose -- so a test can see what was read and how. When left to choose, the
stub "hears" Dutch, and is sure of it unless the audio is under half a second,
which is too little to be sure of anything.
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
    asked = request.get("lang")
    reading = {
        "text": f'heard {milliseconds}ms {asked or "auto"}',
        "lang": asked or "nl",
        "prob": 1.0 if asked else (0.9 if milliseconds >= 500 else 0.4),
    }
    frame(b"A", request["id"], json.dumps(reading).encode("utf-8"))
    frame(b"D", request["id"])
