#!/usr/bin/env python3
"""Local voice for deskmate: Kokoro-82M text-to-speech and faster-whisper speech-to-text behind one tiny HTTP server.

POST /v1/audio/speech          {"input": "text", "voice": "af_heart", "speed": 1.0}  ->  audio/wav (24 kHz, 16-bit mono)
POST /v1/audio/transcriptions  raw audio bytes (WAV/WebM/Ogg/MP3; body is the file)    ->  {"text": "...", "language": "en", ...}
GET  /health                   {"ok": true, "voice": "...", "device": "...", "stt": {...}}
GET  /v1/voices                the preset voice names bundled with Kokoro

Env: DESKMATE_TTS_VOICE (default af_heart), DESKMATE_TTS_PORT (8880), DESKMATE_TTS_HOST (127.0.0.1),
     DESKMATE_TTS_DEVICE (cpu | mps; cpu by default, it is already faster than real time for an 82M model),
     DESKMATE_STT (local | off; off skips loading Whisper), DESKMATE_STT_MODEL (small.en; base.en is lighter,
     small or medium for other languages), DESKMATE_STT_DEVICE (cpu), DESKMATE_STT_COMPUTE (int8),
     DESKMATE_STT_LANGUAGE (empty = detect; ignored by the *.en models).
Run `python server.py --warmup` to download the models once and exit.
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

STT_ENABLED = os.environ.get("DESKMATE_STT", "local").strip().lower() not in ("off", "0", "false", "no")
STT_MODEL = os.environ.get("DESKMATE_STT_MODEL", "").strip() or "small.en"
STT_DEVICE = os.environ.get("DESKMATE_STT_DEVICE", "").strip() or "cpu"
STT_COMPUTE = os.environ.get("DESKMATE_STT_COMPUTE", "").strip() or "int8"
STT_LANGUAGE = os.environ.get("DESKMATE_STT_LANGUAGE", "").strip() or None
MAX_AUDIO_BYTES = 25 * 1024 * 1024

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


class Ears:
    """faster-whisper (CTranslate2) speech-to-text, loaded lazily. Whisper hallucinates on silence, so the
    built-in Silero VAD trims it first and the caller gets no_speech_prob to apply its own threshold."""

    def __init__(self) -> None:
        self._model = None
        self._lock = threading.Lock()
        self.loaded = False

    def model(self):
        if self._model is None:
            from faster_whisper import WhisperModel  # slow import; done once

            t0 = time.time()
            self._model = WhisperModel(STT_MODEL, device=STT_DEVICE, compute_type=STT_COMPUTE)
            self.loaded = True
            print(f"[stt-local] loaded whisper {STT_MODEL} device={STT_DEVICE} compute={STT_COMPUTE} in {time.time() - t0:.1f}s", flush=True)
        return self._model

    @staticmethod
    def _audio(data: bytes):
        """WAV/FLAC/OGG through soundfile as 16 kHz float32 mono (what Whisper wants); anything else goes to
        faster-whisper's own decoder (PyAV) as a stream."""
        import numpy as np
        import soundfile as sf

        try:
            samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        except Exception:  # noqa: BLE001 - not a libsndfile format (e.g. WebM/Opus)
            return io.BytesIO(data)
        mono = samples.mean(axis=1)
        if rate != 16000 and len(mono):
            n = max(1, int(round(len(mono) * 16000 / rate)))
            mono = np.interp(np.linspace(0, len(mono) - 1, n), np.arange(len(mono)), mono).astype("float32")
        return mono

    def transcribe(self, data: bytes, language: str | None) -> dict:
        audio = self._audio(data)
        with self._lock:
            model = self.model()
            segments, info = model.transcribe(
                audio,
                language=language,
                beam_size=1,
                best_of=1,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300, "speech_pad_ms": 200},
                condition_on_previous_text=False,
                without_timestamps=True,
            )
            parts: list[str] = []
            no_speech = 1.0
            logprob = 0.0
            n = 0
            for seg in segments:  # generator: the actual decoding happens here
                parts.append(seg.text.strip())
                no_speech = min(no_speech, float(seg.no_speech_prob))
                logprob += float(seg.avg_logprob)
                n += 1
        text = " ".join(p for p in parts if p)
        return {
            "text": text,
            "language": getattr(info, "language", language),
            "duration": round(float(getattr(info, "duration", 0.0)), 2),
            "no_speech_prob": round(no_speech if n else 1.0, 3),
            "avg_logprob": round(logprob / n, 3) if n else None,
        }


synth = Synth()
ears = Ears()


class Handler(BaseHTTPRequestHandler):
    server_version = "deskmate-voice/2"

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
            self._json(200, {
                "ok": True, "voice": DEFAULT_VOICE, "device": DEVICE, "loaded": sorted(synth._pipelines),
                "stt": {"enabled": STT_ENABLED, "model": STT_MODEL, "loaded": ears.loaded},
            })
        elif self.path == "/v1/voices":
            self._json(200, {"default": DEFAULT_VOICE, "voices": VOICES})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/v1/audio/speech":
            return self._speech()
        if path == "/v1/audio/transcriptions":
            return self._transcribe()
        return self._json(404, {"error": "not found"})

    def _speech(self) -> None:
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

    def _transcribe(self) -> None:
        if not STT_ENABLED:
            return self._json(503, {"error": "speech-to-text is off (DESKMATE_STT=off)"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_AUDIO_BYTES:
            return self._json(400, {"error": "send the audio file as the request body (up to 25 MB)"})
        data = self.rfile.read(length)
        language = STT_LANGUAGE
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        for pair in query.split("&"):
            if pair.startswith("language=") and pair[9:]:
                language = pair[9:]
        t0 = time.time()
        try:
            result = ears.transcribe(data, language)
        except Exception as err:  # noqa: BLE001 - report whatever whisper/av raised
            print(f"[stt-local] transcription failed: {err!r}", flush=True)
            return self._json(500, {"error": str(err)})
        print(f"[stt-local] {len(data)} bytes -> {result['text'][:80]!r} in {time.time() - t0:.2f}s", flush=True)
        self._json(200, result)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--warmup", action="store_true", help="download the models, say one line, exit")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--parent-pid", type=int, default=0, help="exit when this process is gone (set by the app)")
    args = parser.parse_args()

    if args.warmup:
        wav = synth.wav("Hey, I'm all set up and ready to talk.", DEFAULT_VOICE, 1.0)
        print(f"[tts-local] warmup ok: {len(wav)} bytes of WAV", flush=True)
        if STT_ENABLED:
            print(f"[stt-local] downloading whisper {STT_MODEL} (a few hundred MB, once)…", flush=True)
            heard = ears.transcribe(wav, None)
            print(f"[stt-local] warmup ok: heard {heard['text']!r}", flush=True)
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
    stt = f"whisper={STT_MODEL}" if STT_ENABLED else "stt=off"
    print(f"[tts-local] Kokoro serving http://{args.host}:{args.port}/v1/audio/speech  voice={DEFAULT_VOICE} device={DEVICE} {stt}", flush=True)

    # Load the models before the first request so the first reply (and the first thing she hears) is not late.
    def preload() -> None:
        synth.wav("hi", DEFAULT_VOICE, 1.0)
        if STT_ENABLED:
            try:
                ears.model()
            except Exception as err:  # noqa: BLE001
                print(f"[stt-local] could not load whisper {STT_MODEL}: {err!r}", flush=True)

    threading.Thread(target=preload, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
