#!/usr/bin/env bash
# Starts the local Kokoro voice server on http://127.0.0.1:8880 (DESKMATE_TTS_PORT / DESKMATE_TTS_VOICE to change).
set -euo pipefail
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || { echo "run.sh: no .venv yet, run ./setup.sh first" >&2; exit 1; }
exec .venv/bin/python server.py "$@"
