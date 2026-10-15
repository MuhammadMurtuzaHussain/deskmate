# Brains: local (Ollama) or cloud (Gemini)

She needs a vision-capable language model: it reads your messages and, when she looks, a screenshot.

## Option A: local with Ollama (recommended)

Free, private (screenshots never leave your machine), no quota. Needs about 4 GB of RAM headroom.

1. Install Ollama from https://ollama.com (macOS, Windows, Linux) and keep it running.
2. Pull a vision model:
   ```bash
   ollama pull qwen3-vl:4b-instruct      # 3.3 GB; the best small screen-reader
   # alternatives: gemma3:4b (3.4 GB), qwen3-vl:8b-instruct (6.1 GB, needs 16 GB+)
   ```
   Prefer `-instruct` tags. The `-thinking` builds reason for 30+ seconds before every line.
3. In `.env` (or the installed app's settings folder):
   ```
   DESKMATE_BRAIN=ollama
   OLLAMA_MODEL=qwen3-vl:4b-instruct
   ```
4. Start Deskmate. The status line shows `(local)` after the model name.

Any model on https://ollama.com/library or https://ollama.com/search?c=vision works if it accepts images, including community builds. A text-only model can chat but cannot look at the screen.

Typical speed on an Apple M-series laptop with 16 GB: about 1.5 s per reply once warm, 7 s for the first reply after idle.

## Option B: Google AI Studio (Gemini)

Fast and sharp, but the free tier has a daily quota you will hit in an evening of watch mode.

1. Create a key at https://aistudio.google.com/apikey.
2. Either paste it into the field Deskmate shows when no brain is configured, or put it in `.env`:
   ```
   GEMINI_API_KEY=...
   GEMINI_MODEL=gemini-3.8-flash
   ```
3. Leave `DESKMATE_BRAIN` empty, or set it to `gemini`.

When Gemini is out of quota the app falls back to `GEMINI_FALLBACK_MODEL`, and if Ollama is running with the configured model it takes over automatically for five minutes at a time.

## Both

Set `DESKMATE_BRAIN=ollama` and keep a Gemini key too: local by default, nothing lost if Ollama is stopped.

## Other providers

`src/main/gemini.ts` and `src/main/ollama.ts` are each under 80 lines. Any OpenAI-compatible chat endpoint with image input is a short provider away; pull requests welcome.
