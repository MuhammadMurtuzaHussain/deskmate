# Voices

Her lines are synthesized to audio and the Live2D mouth is driven by the audio's volume, so any provider that returns WAV or MP3 lip-syncs.

| provider | cost | quality | setup |
|---|---|---|---|
| Kokoro (local) | free | natural, several presets | one script, ~1 GB download |
| ElevenLabs | free tier, then paid | best | API key |
| System voice (macOS `say`, else the browser voice) | free | robotic | none |

Order: `DESKMATE_TTS=local` → ElevenLabs if a key exists → system voice. Each falls through to the next on failure.

## Kokoro (local, open source, Apache 2.0)

```bash
brew install espeak-ng          # macOS; apt install espeak-ng on Linux
tts-local/setup.sh              # creates tts-local/.venv and downloads the model
```
then in `.env`:
```
DESKMATE_TTS=local
DESKMATE_TTS_VOICE=af_heart     # af_bella, af_nicole, af_sarah, bf_emma, … see tts-local/server.py
```
Deskmate starts the server itself when the app launches (set `DESKMATE_TTS_AUTOSTART=0` to run `tts-local/run.sh` yourself). For the installed app, run `setup.sh` from a source checkout and point `DESKMATE_TTS_URL` at it, or create the venv under your user-data folder as `tts-local/.venv`. Windows: `setup.sh` is a bash script; use Git Bash or WSL, or run the Kokoro-FastAPI Docker image and set `DESKMATE_TTS_URL`.

Samples of each preset are in `docs/voice-samples/`.

## ElevenLabs

```
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=pFZP5JQG7iQjIQuC4Bku   # Lily; any built-in voice id works on the free tier
ELEVENLABS_MODEL=eleven_flash_v2_5         # or eleven_multilingual_v2 for quality
```
Voice Library voices need a paid plan to be used through the API; built-in voices do not.

## Per character

Each `character.json` carries its own `voice` block (Kokoro preset, ElevenLabs id, system voice), so switching characters switches voices. `.env` values override all characters at once.
