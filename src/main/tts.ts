import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CharacterVoice } from '../shared/types'

const execFileP = promisify(execFile)

export interface Audio {
  bytes: Uint8Array
  mime: string
}

const LOCAL_URL_DEFAULT = 'http://127.0.0.1:8880/v1/audio/speech'
let warnedLocalDown = false

type TtsProvider = 'local' | 'elevenlabs' | 'say'

/** `DESKMATE_TTS`: local (Kokoro, the default) | elevenlabs | say. */
function ttsProvider(): TtsProvider {
  const v = (process.env.DESKMATE_TTS || '').trim().toLowerCase()
  return v === 'elevenlabs' || v === 'say' ? v : 'local'
}

/** True when the Kokoro server in tts-local/ is her voice: unless `DESKMATE_TTS` picks ElevenLabs or `say`. */
export function localTtsSelected(): boolean {
  return ttsProvider() === 'local'
}

/**
 * True when she should hear: `DESKMATE_STT=local`, or `DESKMATE_TTS=local` is set and DESKMATE_STT is unset. The local
 * voice being the default does not turn her ears on by itself; that stays an explicit choice.
 */
export function localSttSelected(): boolean {
  const v = (process.env.DESKMATE_STT || '').trim().toLowerCase()
  if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false
  if (v === 'local') return true
  return (process.env.DESKMATE_TTS || '').trim().toLowerCase() === 'local'
}

/**
 * Voice. The local Kokoro server first (unless `DESKMATE_TTS=elevenlabs` or `say`), then ElevenLabs if a key is set,
 * then macOS `say`. Each provider falls through to the next when it fails.
 * Returns null when no synthesizer is available; the renderer then falls back to the browser voice.
 */
export async function synthesize(text: string, voice: CharacterVoice): Promise<Audio | null> {
  const provider = ttsProvider()
  if (provider === 'local') {
    try {
      const audio = await localKokoro(text, voice)
      warnedLocalDown = false
      return audio
    } catch (err) {
      if (!warnedLocalDown) {
        warnedLocalDown = true
        console.warn(`[tts] local server (${localTtsUrl()}) failed, falling back: ${(err as Error).message}. Run tts-local/setup.sh once, then restart (or tts-local/run.sh with DESKMATE_TTS_AUTOSTART=0).`)
      }
    }
  }
  const key = process.env.ELEVENLABS_API_KEY
  if (key && provider !== 'say') {
    try {
      return await elevenLabs(text, key, voice.elevenlabs || process.env.ELEVENLABS_VOICE_ID || 'pFZP5JQG7iQjIQuC4Bku')
    } catch (err) {
      console.warn('[tts] ElevenLabs failed, falling back:', (err as Error).message)
    }
  }
  if (process.platform === 'darwin') {
    try {
      return await macSay(text, voice.say || 'Samantha')
    } catch (err) {
      console.warn('[tts] say failed:', (err as Error).message)
    }
  }
  return null
}

function localTtsUrl(): string {
  return process.env.DESKMATE_TTS_URL?.trim() || LOCAL_URL_DEFAULT
}

/** Kokoro through tts-local/server.py (or any OpenAI-style /v1/audio/speech endpoint that returns WAV). */
async function localKokoro(text: string, voice: CharacterVoice): Promise<Audio> {
  const res = await fetch(localTtsUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      input: text,
      // Env overrides the character's own voice, so one .env line can retune everyone.
      voice: process.env.DESKMATE_TTS_VOICE?.trim() || voice.kokoro || 'af_heart',
      speed: Number(process.env.DESKMATE_TTS_SPEED) || voice.speed || 1
    })
  })
  if (!res.ok) throw new Error(`local TTS HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength < 100) throw new Error('local TTS returned no audio')
  return { bytes, mime: 'audio/wav' }
}

const PYTHON_BIN = process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python')

/** The venv lives next to the scripts in a checkout, or under the user-data folder for the packaged app (whose
 * Resources must not change: that would break its signature). */
export function venvCandidates(root: string, userData?: string): string[] {
  return [join(root, 'tts-local', '.venv'), ...(userData ? [join(userData, 'tts-local', '.venv')] : [])]
}

/** The Kokoro venv that is set up, or null. */
export function localTtsVenv(root: string, userData?: string): string | null {
  return venvCandidates(root, userData).find((v) => existsSync(join(v, PYTHON_BIN))) ?? null
}

/**
 * Starts tts-local/server.py from its venv when Kokoro is her voice (the default) or her ears are local, unless a server already answers or
 * `DESKMATE_TTS_AUTOSTART=0`. Returns a stop function for app quit (no-op when nothing was started).
 */
export async function autostartLocalTts(root: string, userData?: string): Promise<() => void> {
  const noop = (): void => undefined
  if (!(localTtsSelected() || localSttSelected()) || process.env.DESKMATE_TTS_AUTOSTART === '0') return noop
  if (process.env.DESKMATE_TTS_URL?.trim() && !localTtsUrl().startsWith('http://127.0.0.1')) return noop
  const dir = join(root, 'tts-local')
  const venv = localTtsVenv(root, userData)
  if (!venv) {
    console.warn(`[tts] the Kokoro voice is not set up (no venv in ${venvCandidates(root, userData).join(' or ')}); Setup → Her voice → Install, or run tts-local/setup.sh. Until then she uses ElevenLabs (with a key) or the system voice`)
    return noop
  }
  const python = join(venv, PYTHON_BIN)
  if (await localTtsHealthy()) {
    // A server left behind by an earlier run can answer /health and still fail every line, so say one word to check.
    const works = await localKokoro('hi', {}).then(
      () => true,
      () => false
    )
    if (works) console.log('[tts] local server already running at', localTtsUrl())
    else console.warn(`[tts] a server at ${localTtsUrl()} answers but cannot speak (left over from an earlier run?); quit it (lsof -iTCP:${new URL(localTtsUrl()).port || 8880}) and restart`)
    return noop
  }
  const port = String(new URL(localTtsUrl()).port || 8880)
  const child: ChildProcess = spawn(python, [join(dir, 'server.py'), '--port', port, '--parent-pid', String(process.pid)], {
    cwd: dir,
    // The same server does speech-to-text; tell it whether to load Whisper at all.
    env: { ...process.env, PYTHONUNBUFFERED: '1', DESKMATE_STT: localSttSelected() ? process.env.DESKMATE_STT || 'local' : 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(d.toString()))
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d.toString()))
  child.on('exit', (code, signal) => console.log(`[tts] local server exited (${code ?? signal})`))
  console.log(`[tts] started local Kokoro server (pid ${child.pid}) on port ${port}`)
  return () => {
    if (!child.killed) child.kill('SIGTERM')
  }
}

export async function localTtsHealthy(): Promise<boolean> {
  try {
    const res = await fetch(new URL('/health', localTtsUrl()), { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function elevenLabs(text: string, key: string, voiceId: string): Promise<Audio> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        text,
        // eleven_flash_v2_5 is fastest; eleven_multilingual_v2 sounds closer to the previews on the ElevenLabs site.
        model_id: process.env.ELEVENLABS_MODEL?.trim() || 'eleven_flash_v2_5',
        // ElevenLabs' own defaults. Lower stability = more expressive but also more different from the preview.
        voice_settings: {
          stability: Number(process.env.ELEVENLABS_STABILITY) || 0.5,
          similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY) || 0.75
        }
      })
    }
  )
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`)
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: 'audio/mpeg' }
}

async function macSay(text: string, voice: string): Promise<Audio> {
  const file = join(tmpdir(), `deskmate-${Date.now()}.wav`)
  await execFileP('say', ['-v', voice, '-o', file, '--file-format=WAVE', '--data-format=LEI16@22050', text])
  const bytes = await readFile(file)
  await unlink(file).catch(() => undefined)
  return { bytes: new Uint8Array(bytes), mime: 'audio/wav' }
}
