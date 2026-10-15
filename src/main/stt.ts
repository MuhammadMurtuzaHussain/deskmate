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

/**
 * Sends one utterance (WAV, WebM or Ogg) to the local faster-whisper endpoint in tts-local/server.py. The server
 * takes `?prompt=` to bias Whisper's spelling, but her name is matched loosely instead (wake.ts): primed with the
 * name, Whisper hears it in any noise.
 */
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

// ---- PCM WAV helpers, for the cheap always-on ear: a long utterance that is not for her is only transcribed far
// enough to look for her name at the start.

interface WavLayout {
  rate: number
  channels: number
  bits: number
  dataStart: number
  dataSize: number
}

function wavLayout(bytes: Uint8Array): WavLayout | null {
  if (bytes.length < 12) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number): string => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let rate = 0
  let channels = 0
  let bits = 0
  for (let o = 12; o + 8 <= bytes.length; ) {
    const id = tag(o)
    const size = view.getUint32(o + 4, true)
    if (id === 'fmt ' && o + 24 <= bytes.length) {
      channels = view.getUint16(o + 10, true)
      rate = view.getUint32(o + 12, true)
      bits = view.getUint16(o + 22, true)
    } else if (id === 'data') {
      if (!rate || !channels || !bits) return null
      return { rate, channels, bits, dataStart: o + 8, dataSize: Math.min(size, bytes.length - (o + 8)) }
    }
    o += 8 + size + (size & 1)
  }
  return null
}

/** Length of a PCM WAV in milliseconds; 0 when the header makes no sense. */
export function wavDurationMs(bytes: Uint8Array): number {
  const w = wavLayout(bytes)
  if (!w) return 0
  return Math.round((w.dataSize / ((w.rate * w.channels * w.bits) / 8)) * 1000)
}

/** The first `seconds` of a PCM WAV as a WAV of its own (the input itself when it is already that short). */
export function wavHead(bytes: Uint8Array, seconds: number): Uint8Array {
  const w = wavLayout(bytes)
  if (!w) return bytes
  const frame = (w.channels * w.bits) / 8
  const keep = Math.floor((seconds * w.rate * frame) / frame) * frame
  if (w.dataSize <= keep) return bytes
  const out = new Uint8Array(w.dataStart + keep)
  out.set(bytes.subarray(0, w.dataStart + keep))
  const view = new DataView(out.buffer)
  view.setUint32(4, out.length - 8, true)
  view.setUint32(w.dataStart - 4, keep, true)
  return out
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
