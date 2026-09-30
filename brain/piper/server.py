"""
A Piper synthesiser that stays running, for the brain to talk to.

Loading a voice takes a second and a half; reading a sentence with it takes a
tenth of that. So the model is loaded once, here, and the brain sends
sentences down a pipe for as long as it lives.

The protocol is deliberately small. In, on stdin, one JSON object per line:

    {"id": 7, "voice": "en_GB-alan-medium", "text": "Good morning.", "speed": 1.0}

Out, on stdout, binary frames: a kind byte, the request id and the payload
length as big-endian uint32, then the payload.

    R  ready; the preloaded voices are in memory
    A  audio: signed 16-bit little-endian mono PCM at 16 kHz, what the HUD plays
    D  the request is finished
    E  the request failed; the payload is the reason

Piper speaks at its voice's own rate, 22.05 kHz for most. It is resampled here
so that the brain and the HUD see the same audio every other voice produces.
Anything meant for a human goes to stderr; stdout carries frames and nothing else.

    python server.py <models-dir> [voice ...]
"""

import json
import os
import struct
import sys

import numpy as np
from piper import PiperVoice, SynthesisConfig

OUT_RATE = 16000

out = sys.stdout.buffer
voices = {}


def frame(kind, rid, payload=b""):
    out.write(kind + struct.pack(">II", rid, len(payload)) + payload)
    out.flush()


def load(models, name):
    if name not in voices:
        voices[name] = PiperVoice.load(os.path.join(models, name + ".onnx"))
    return voices[name]


def resample(pcm, rate):
    """Band-limited by construction: keep the low bins of the spectrum, drop the rest."""
    if rate == OUT_RATE or len(pcm) == 0:
        return pcm
    n = len(pcm)
    m = max(1, round(n * OUT_RATE / rate))
    spectrum = np.fft.rfft(pcm.astype(np.float64))
    keep = m // 2 + 1
    if keep > len(spectrum):
        spectrum = np.pad(spectrum, (0, keep - len(spectrum)))
    shaped = np.fft.irfft(spectrum[:keep], m) * (m / n)
    return np.clip(shaped, -32768, 32767).astype("<i2")


def speak(models, request):
    rid = int(request["id"])
    try:
        voice = load(models, request["voice"])
        speed = float(request.get("speed") or 1.0)
        config = SynthesisConfig(length_scale=1.0 / speed)
        for chunk in voice.synthesize(request["text"], syn_config=config):
            pcm = np.frombuffer(chunk.audio_int16_bytes, dtype="<i2")
            frame(b"A", rid, resample(pcm, chunk.sample_rate).tobytes())
        frame(b"D", rid)
    except Exception as error:  # one bad sentence must not take the voice down
        frame(b"E", rid, str(error).encode("utf-8"))


def main():
    models = sys.argv[1]
    for name in sys.argv[2:]:
        try:
            load(models, name)
        except Exception as error:
            print(f"piper: could not preload {name}: {error}", file=sys.stderr)
    frame(b"R", 0)
    for line in sys.stdin:
        line = line.strip()
        if line:
            speak(models, json.loads(line))


if __name__ == "__main__":
    main()
