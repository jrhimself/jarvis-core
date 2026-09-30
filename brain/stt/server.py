"""
A Whisper transcriber that stays running, for the brain to talk to.

Loading the model takes seconds; reading a sentence with it takes a fraction of
that. So it is loaded once, here, and the brain sends stretches of speech down
a pipe for as long as it lives. The framing is the one `piper/server.py` uses;
`src/voice/pipe.ts` describes it.

In, one JSON object per line:

    {"id": 7, "audio": "<base64 signed 16-bit little-endian mono PCM, 16 kHz>",
     "lang": "nl"}                       read it as Dutch
     "langs": ["nl", "en"]               or: work out which of these it is

Out: an `A` frame with `{"text": ..., "lang": ..., "prob": ...}`, then `D`; or
`E` with the reason. `R` once, when the model is loaded. The text is empty when
nothing was said.

Whisper invents words for silence and for noise -- "Thank you." is the famous
one -- so the audio goes through its voice-activity filter first and a stretch
with no speech in it yields no text at all.

Whisper also does not guess, when it is told a language: it reads whatever it
hears as that language, which for Dutch read as English is a translation, word
by wrong word. So the language is the caller's to give, and when it is not
known the model is asked to pick, from only the languages that are possible.
Picking costs a second more on a slow CPU, which is why the caller does it once.

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


def read(model, audio, language):
    segments, info = model.transcribe(
        audio,
        language=language,
        beam_size=1,
        vad_filter=True,
        # Each stretch is its own utterance; carrying the last one's text
        # forward is how Whisper falls into repeating itself.
        condition_on_previous_text=False,
        # No retries at a higher temperature. Whisper falls back to them when a
        # reading looks wrong, and each retry is another full decode: a reading that
        # takes one second becomes four, and the person is waiting for it.
        temperature=0.0,
    )
    return " ".join(segment.text.strip() for segment in segments).strip(), info


def transcribe(model, request):
    rid = int(request["id"])
    try:
        pcm = np.frombuffer(base64.b64decode(request["audio"]), dtype="<i2")
        audio = pcm.astype(np.float32) / 32768.0

        language = request.get("lang")
        if language:
            text, _ = read(model, audio, language)
            probability = 1.0
        else:
            allowed = request.get("langs") or []
            text, info = read(model, audio, None)
            language, probability = info.language, info.language_probability
            if allowed and language not in allowed:
                # Heard as something the person does not speak: take the likeliest
                # of the ones they do, and read it again in that.
                scores = dict(info.all_language_probs or [])
                language = max(allowed, key=lambda candidate: scores.get(candidate, 0.0))
                probability = scores.get(language, 0.0)
                text, _ = read(model, audio, language)

        reading = {"text": text, "lang": language, "prob": round(float(probability), 3)}
        frame(b"A", rid, json.dumps(reading).encode("utf-8"))
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
