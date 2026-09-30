"""
A Whisper transcriber that stays running, for the brain to talk to.

Loading the model takes seconds; reading a sentence with it takes a fraction of
that. So it is loaded once, here, and the brain sends stretches of speech down
a pipe for as long as it lives. The framing is the one `piper/server.py` uses;
`src/voice/pipe.ts` describes it.

In, one JSON object per line:

    {"id": 7, "lang": "en", "audio": "<base64 signed 16-bit little-endian mono PCM, 16 kHz>"}

Out: an `A` frame carrying the text heard (absent when nothing was said), then
`D`; or `E` with the reason. `R` once, when the model is loaded.

Whisper invents words for silence and for noise -- "Thank you." is the famous
one -- so the audio goes through its voice-activity filter first and a stretch
with no speech in it yields no text at all.

    python server.py <model-dir> <model-size>
"""

import base64
import json
import struct
import sys

import numpy as np
from faster_whisper import WhisperModel

out = sys.stdout.buffer


def frame(kind, rid, payload=b""):
    out.write(kind + struct.pack(">II", rid, len(payload)) + payload)
    out.flush()


def transcribe(model, request):
    rid = int(request["id"])
    try:
        pcm = np.frombuffer(base64.b64decode(request["audio"]), dtype="<i2")
        audio = pcm.astype(np.float32) / 32768.0
        segments, _ = model.transcribe(
            audio,
            language=request.get("lang") or None,
            beam_size=1,
            vad_filter=True,
            # Each stretch is its own utterance; carrying the last one's text
            # forward is how Whisper falls into repeating itself.
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        if text:
            frame(b"A", rid, text.encode("utf-8"))
        frame(b"D", rid)
    except Exception as error:  # one bad stretch must not take the ear down
        frame(b"E", rid, str(error).encode("utf-8"))


def main():
    directory, size = sys.argv[1], sys.argv[2]
    model = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=2, download_root=directory)
    frame(b"R", 0)
    for line in sys.stdin:
        line = line.strip()
        if line:
            transcribe(model, json.loads(line))


if __name__ == "__main__":
    main()
