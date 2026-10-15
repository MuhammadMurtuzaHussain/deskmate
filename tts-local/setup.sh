#!/usr/bin/env bash
# One-time setup for the local voice: a venv with Kokoro, then a warmup that downloads the model (~330 MB).
# Needs Python 3.10–3.12 (Kokoro does not support 3.13+ yet) and espeak-ng:  brew install espeak-ng
set -euo pipefail
cd "$(dirname "$0")"

PY=""
for candidate in python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)'; then
      PY="$candidate"; break
    fi
  fi
done
if [ -z "$PY" ]; then
  echo "setup.sh: need Python 3.10–3.12 on PATH (brew install python@3.12)" >&2
  exit 1
fi

if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "setup.sh: espeak-ng not found; Kokoro uses it for words outside its dictionary. Install it with:  brew install espeak-ng" >&2
  echo "          (continuing; most English text works without it)" >&2
fi

echo "setup.sh: creating .venv with $("$PY" --version)"
[ -d .venv ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -r requirements.txt
echo "setup.sh: downloading the Kokoro voice (~330 MB) and Whisper ${DESKMATE_STT_MODEL:-small.en} for listening (~480 MB), then a test line…"
echo "          (DESKMATE_STT=off skips Whisper; DESKMATE_STT_MODEL=base.en is a lighter ear)"
.venv/bin/python server.py --warmup
echo "setup.sh: done. Start the server with ./run.sh (or let the app start it: DESKMATE_TTS=local in .env)."
