ElevenLabs built-in voices that work on a free-tier key, all saying the same line. Set the id in `.env`:

| file | voice | ELEVENLABS_VOICE_ID |
|---|---|---|
| jessica.mp3 | Jessica, playful and bright | cgSgspJ2msm6clMCkdW9 |
| lily.mp3 | Lily, warm and soft (default) | pFZP5JQG7iQjIQuC4Bku |
| alice.mp3 | Alice, clear, British | Xb7hH8MSUJpSbSDYk0k2 |
| laura.mp3 | Laura, upbeat | FGY2WhTYpPnrIDTdsKH5 |

Voices from the ElevenLabs Voice Library need a Creator plan or paid credits to be used through the API; the built-in ones above do not. Aria and Charlotte are also built in but need a paid plan.

Local voices (Kokoro-82M, no key, see the README's "Local voice" section), same line, set `DESKMATE_TTS=local` and the preset in `DESKMATE_TTS_VOICE`:

| file | voice |
|---|---|
| kokoro-af_heart.wav | af_heart, warm and even (default) |
| kokoro-af_bella.wav | af_bella, brighter, a little more playful |
| kokoro-af_nicole.wav | af_nicole, soft, close to a whisper |
