import { localSttSelected } from './tts'

export { localSttSelected }

const DEFAULT_URL = 'http://127.0.0.1:8880/v1/audio/transcriptions'

export function sttUrl(): string {
  return process.env.DESKMATE_STT_URL?.trim() || DEFAULT_URL
}

export interface Transcript {
  text: string
  language?: string
  duration?: number
  /** Whisper's own estimate that the clip holds no speech at all (0..1) */
  noSpeechProb?: number
  avgLogprob?: number | null
}

/** Sends one utterance (WAV, WebM or Ogg) to the local faster-whisper endpoint in tts-local/server.py. */
export async function transcribe(audio: Uint8Array, mime = 'audio/wav'): Promise<Transcript> {
  const res = await fetch(sttUrl(), {
    method: 'POST',
    headers: { 'content-type': mime },
    body: new Blob([audio as BlobPart], { type: mime }),
    signal: AbortSignal.timeout(60_000)
  })
  if (!res.ok) throw new Error(`local STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { text?: string; language?: string; duration?: number; no_speech_prob?: number; avg_logprob?: number | null }
  return { text: data.text ?? '', language: data.language, duration: data.duration, noSpeechProb: data.no_speech_prob, avgLogprob: data.avg_logprob }
}

// What Whisper says when it hears nothing: breathing, a chair, the fan. Never worth a reply.
const JUNK = new Set([
  'thank you', 'thanks', 'thanks for watching', 'thank you for watching', 'you', 'bye', 'the end', 'so', 'oh', 'uh', 'um',
  'hmm', 'okay', 'ok', 'yeah', 'mm', 'mm-hmm', 'ah', 'subtitles by the amara.org community', 'please subscribe'
])

/** The spoken text, or null when the clip was silence, noise or a Whisper hallucination. */
export function cleanTranscript(t: Transcript): string | null {
  const text = t.text.replace(/\s+/g, ' ').trim()
  if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return null
  if ((t.noSpeechProb ?? 0) > 0.7) return null
  if (JUNK.has(text.toLowerCase().replace(/[.!?,…]+$/g, '').trim())) return null
  return text
}

/** True when the voice server answers and has speech-to-text switched on. */
export async function sttHealthy(): Promise<boolean> {
  try {
    const res = await fetch(new URL('/health', sttUrl()), { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const data = (await res.json()) as { stt?: { enabled?: boolean } }
    return data.stt?.enabled !== false
  } catch {
    return false
  }
}
