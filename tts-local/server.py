#!/usr/bin/env python3
"""Local text-to-speech for deskmate: Kokoro-82M behind a tiny HTTP server.

POST /v1/audio/speech   {"input": "text", "voice": "af_heart", "speed": 1.0}  ->  audio/wav (24 kHz, 16-bit mono)
GET  /health            {"ok": true, "voice": "...", "device": "..."}
GET  /v1/voices         the preset voice names bundled with Kokoro

Env: DESKMATE_TTS_VOICE (default af_heart), DESKMATE_TTS_PORT (8880), DESKMATE_TTS_HOST (127.0.0.1),
     DESKMATE_TTS_DEVICE (cpu | mps; cpu by default, it is already faster than real time for an 82M model).
Run `python server.py --warmup` to download the model and voices once and exit.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_VOICE = os.environ.get("DESKMATE_TTS_VOICE", "").strip() or "af_heart"
PORT = int(os.environ.get("DESKMATE_TTS_PORT") or 8880)
HOST = os.environ.get("DESKMATE_TTS_HOST") or "127.0.0.1"
DEVICE = os.environ.get("DESKMATE_TTS_DEVICE", "").strip() or "cpu"
REPO_ID = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24000

# Female presets that suit a desk companion, first; the rest of the bundled English voices after.
VOICES = [
    "af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah", "af_nova", "af_sky",
    "af_alloy", "af_jessica", "af_river", "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
    "am_michael", "am_fenrir", "am_puck", "am_echo", "am_eric", "am_liam", "am_onyx", "am_adam",
    "am_santa", "bm_george", "bm_fable", "bm_lewis", "bm_daniel",
]


class Synth:
    """One KPipeline per language code (the voice's first letter: a = American, b = British), loaded lazily."""

    def __init__(self) -> None:
        self._pipelines: dict[str, object] = {}
        self._lock = threading.Lock()

    def _pipeline(self, lang: str):
        pipe = self._pipelines.get(lang)
        if pipe is None:
            from kokoro import KPipeline  # slow import (torch); done once

            t0 = time.time()
            pipe = KPipeline(lang_code=lang, repo_id=REPO_ID, device=DEVICE)
            self._pipelines[lang] = pipe
            print(f"[tts-local] loaded Kokoro lang={lang} device={DEVICE} in {time.time() - t0:.1f}s", flush=True)
        return pipe

    def wav(self, text: str, voice: str, speed: float) -> bytes:
        import numpy as np
        import soundfile as sf

        lang = voice[0] if voice and voice[0] in ("a", "b") else "a"
        with self._lock:  # torch inference is not safe to run concurrently from several threads
            pipe = self._pipeline(lang)
            chunks = []
            for _graphemes, _phonemes, audio in pipe(text, voice=voice, speed=speed):
                if audio is None:
                    continue
                chunks.append(audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio))
        samples = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        buf = io.BytesIO()
        sf.write(buf, samples, SAMPLE_RATE, format="WAV", subtype="PCM_16")
        return buf.getvalue()


synth = Synth()


class Handler(BaseHTTPRequestHandler):
    server_version = "deskmate-tts/1"

    def log_message(self, fmt, *args):  # quieter than the default access log
        if os.environ.get("DESKMATE_TTS_LOG"):
            super().log_message(fmt, *args)

    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"ok": True, "voice": DEFAULT_VOICE, "device": DEVICE, "loaded": sorted(synth._pipelines)})
        elif self.path == "/v1/voices":
            self._json(200, {"default": DEFAULT_VOICE, "voices": VOICES})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/v1/audio/speech":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            text = str(body.get("input") or body.get("text") or "").strip()
            voice = str(body.get("voice") or DEFAULT_VOICE).strip() or DEFAULT_VOICE
            speed = float(body.get("speed") or 1.0)
        except (ValueError, json.JSONDecodeError) as err:
            return self._json(400, {"error": f"bad request: {err}"})
        if not text:
            return self._json(400, {"error": "input is empty"})
        if voice not in VOICES:
            return self._json(400, {"error": f"unknown voice {voice!r}; GET /v1/voices lists the presets"})
        t0 = time.time()
        try:
            wav = synth.wav(text[:4000], voice, speed)
        except Exception as err:  # noqa: BLE001 - report whatever Kokoro raised
            print(f"[tts-local] synth failed: {err!r}", flush=True)
            return self._json(500, {"error": str(err)})
        print(f"[tts-local] {voice} {len(text)} chars -> {len(wav)} bytes in {time.time() - t0:.2f}s", flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--warmup", action="store_true", help="download the model, say one line, exit")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--parent-pid", type=int, default=0, help="exit when this process is gone (set by the app)")
    args = parser.parse_args()

    if args.warmup:
        wav = synth.wav("Hey, I'm all set up and ready to talk.", DEFAULT_VOICE, 1.0)
        print(f"[tts-local] warmup ok: {len(wav)} bytes of WAV", flush=True)
        return 0

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    if args.parent_pid:
        # The app that started us may be killed without a chance to stop us; do not outlive it.
        def watch_parent() -> None:
            while True:
                time.sleep(2)
                try:
                    os.kill(args.parent_pid, 0)
                except OSError:
                    print("[tts-local] parent gone, exiting", flush=True)
                    os._exit(0)

        threading.Thread(target=watch_parent, daemon=True).start()
    print(f"[tts-local] Kokoro serving http://{args.host}:{args.port}/v1/audio/speech  voice={DEFAULT_VOICE} device={DEVICE}", flush=True)
    # Load the model before the first request so the first reply is not late.
    threading.Thread(target=lambda: synth.wav("hi", DEFAULT_VOICE, 1.0), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
