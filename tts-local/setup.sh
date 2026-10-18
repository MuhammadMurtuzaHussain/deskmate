#!/usr/bin/env bash
# One-time setup for the local voice: a venv with Kokoro, then a warmup that downloads the model (~330 MB).
# Needs Python 3.10–3.12 (Kokoro does not support 3.13+ yet) and espeak-ng:  brew install espeak-ng
# With uv installed and no suitable Python, uv fetches one.
#
# DESKMATE_TTS_VENV puts the venv somewhere else: the packaged app runs this script from inside Deskmate.app and keeps
# the venv under its user-data folder (Setup → Her voice → Install). Lines starting "setup.sh: [n/4]" mark the steps;
# Setup reads them for its progress bar.
set -euo pipefail
cd "$(dirname "$0")"
VENV="${DESKMATE_TTS_VENV:-.venv}"
# GUI apps start with a short PATH; Homebrew's Python and espeak-ng live here.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"

echo "setup.sh: [1/4] looking for Python 3.10–3.12"
PY=""
for candidate in python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)'; then
      PY="$candidate"; break
    fi
  fi
done
USE_UV=""
if [ -z "$PY" ]; then
  if command -v uv >/dev/null 2>&1; then
    USE_UV=1
  else
    echo "setup.sh: need Python 3.10–3.12 on PATH (brew install python@3.12)" >&2
    exit 1
  fi
fi

if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "setup.sh: espeak-ng not found; Kokoro uses it for words outside its dictionary. Install it with:  brew install espeak-ng" >&2
  echo "          (continuing; most English text works without it)" >&2
fi

if [ -n "$USE_UV" ]; then
  echo "setup.sh: [2/4] creating $VENV with uv (Python 3.12)"
  [ -x "$VENV/bin/python" ] || uv venv --python 3.12 --seed "$VENV"
else
  echo "setup.sh: [2/4] creating $VENV with $("$PY" --version)"
  [ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
fi
echo "setup.sh: [3/4] installing Kokoro and Whisper (a few minutes the first time)"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -r requirements.txt
echo "setup.sh: [4/4] downloading the Kokoro voice (~330 MB) and Whisper ${DESKMATE_STT_MODEL:-small.en} for listening (~480 MB), then a test line…"
echo "          (DESKMATE_STT=off skips Whisper; DESKMATE_STT_MODEL=base.en is a lighter ear)"
"$VENV/bin/python" server.py --warmup
echo "setup.sh: done. Start the server with ./run.sh (or let the app start it: DESKMATE_TTS=local in .env)."
