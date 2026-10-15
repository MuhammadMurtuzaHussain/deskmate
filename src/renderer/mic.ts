import { resolveAsset } from './assets'

export interface MicOptions {
  /** one utterance: 16 kHz mono 16-bit WAV, and how long it was */
  onUtterance(wav: ArrayBuffer, ms: number): void
  /** input level (RMS 0..1) and whether speech is being collected right now */
  onLevel?(rms: number, speaking: boolean): void
  onError?(message: string): void
}

export interface Mic {
  start(): Promise<void>
  stop(): void
  /** while she is talking the mic is ignored, so she does not answer herself */
  setBlocked(blocked: boolean): void
  readonly active: boolean
}

const RATE = 16000
const PRE_ROLL_MS = 400 // kept from before speech was detected, so the first syllable survives
const START_MS = 120 // this long above the threshold starts an utterance
const END_MS = 800 // this long below it ends one
const MIN_SPEECH_MS = 450 // shorter than this is a cough or a click
const MAX_UTTERANCE_MS = 25_000

/**
 * Hands-free listening: the mic streams through an AudioWorklet into a small energy-based voice activity
 * detector; each utterance is cut at the pause and shipped to the main process as WAV for Whisper.
 */
export function createMic(opts: MicOptions): Mic {
  let ctx: AudioContext | null = null
  let stream: MediaStream | null = null
  let node: AudioWorkletNode | null = null
  let blocked = false
  let active = false

  // VAD state
  let preRoll: Float32Array[] = []
  let preRollSamples = 0
  let utterance: Float32Array[] = []
  let utteranceSamples = 0
  let inSpeech = false
  let speechRunMs = 0
  let silenceRunMs = 0
  let noise = 0.004

  function reset(): void {
    preRoll = []
    preRollSamples = 0
    utterance = []
    utteranceSamples = 0
    inSpeech = false
    speechRunMs = 0
    silenceRunMs = 0
  }

  function onChunk(chunk: Float32Array): void {
    if (blocked) {
      if (inSpeech || preRoll.length) reset()
      return
    }
    let sum = 0
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
    const rms = Math.sqrt(sum / chunk.length)
    const threshold = Math.max(0.01, noise * 3.2)
    const loud = rms > threshold
    if (!inSpeech && !loud) noise = noise * 0.95 + rms * 0.05 // follow the room while nobody talks
    opts.onLevel?.(rms, inSpeech)
    const chunkMs = (chunk.length / RATE) * 1000

    if (!inSpeech) {
      preRoll.push(chunk)
      preRollSamples += chunk.length
      while (preRollSamples > (RATE * PRE_ROLL_MS) / 1000 && preRoll.length > 1) preRollSamples -= preRoll.shift()!.length
      if (loud) {
        speechRunMs += chunkMs
        if (speechRunMs >= START_MS) {
          inSpeech = true
          utterance = [...preRoll]
          utteranceSamples = preRollSamples
          silenceRunMs = 0
        }
      } else {
        speechRunMs = 0
      }
      return
    }

    utterance.push(chunk)
    utteranceSamples += chunk.length
    silenceRunMs = loud ? 0 : silenceRunMs + chunkMs
    const durationMs = (utteranceSamples / RATE) * 1000
    if (silenceRunMs >= END_MS || durationMs >= MAX_UTTERANCE_MS) {
      const speechMs = durationMs - silenceRunMs - PRE_ROLL_MS
      const samples = concat(utterance, utteranceSamples)
      reset()
      if (speechMs >= MIN_SPEECH_MS) opts.onUtterance(encodeWav(samples, RATE), Math.round(durationMs))
    }
  }

  return {
    get active() {
      return active
    },
    async start() {
      if (active) return
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        })
        // The context runs at the device's own rate; the resampler brings it to Whisper's 16 kHz in JS, which works
        // the same on every platform (a 16 kHz context fed by a 48 kHz stream does not, everywhere).
        ctx = new AudioContext()
        await ctx.audioWorklet.addModule(resolveAsset('/mic-worklet.js'))
        const source = ctx.createMediaStreamSource(stream)
        const resampler = new Resampler(ctx.sampleRate, RATE)
        node = new AudioWorkletNode(ctx, 'mic-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
        node.port.onmessage = (e: MessageEvent<Float32Array>) => onChunk(resampler.process(e.data))
        // A silent path to the destination keeps the graph running; nothing is audible.
        const mute = ctx.createGain()
        mute.gain.value = 0
        source.connect(node)
        node.connect(mute)
        mute.connect(ctx.destination)
        if (ctx.state === 'suspended') await ctx.resume()
        reset()
        active = true
      } catch (err) {
        this.stop()
        const message = err instanceof Error ? err.message : String(err)
        opts.onError?.(/denied|permission|NotAllowed/i.test(message) ? 'microphone access was refused' : message)
        throw err
      }
    },
    stop() {
      active = false
      node?.port.close()
      node?.disconnect()
      node = null
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      void ctx?.close()
      ctx = null
      reset()
    },
    setBlocked(b: boolean) {
      blocked = b
      if (b) reset()
    }
  }
}

/** Streaming linear-interpolation resampler; good enough for speech going into Whisper. */
class Resampler {
  private carry = new Float32Array(0)
  private t = 0

  constructor(
    private readonly from: number,
    private readonly to: number
  ) {}

  process(chunk: Float32Array): Float32Array {
    if (this.from === this.to) return chunk
    const input = new Float32Array(this.carry.length + chunk.length)
    input.set(this.carry, 0)
    input.set(chunk, this.carry.length)
    const step = this.from / this.to
    const out = new Float32Array(Math.ceil((input.length - this.t) / step) + 1)
    let n = 0
    let t = this.t
    while (t + 1 < input.length) {
      const i = Math.floor(t)
      const f = t - i
      out[n++] = input[i] * (1 - f) + input[i + 1] * f
      t += step
    }
    const consumed = Math.floor(t)
    this.carry = input.slice(Math.min(consumed, input.length))
    this.t = t - Math.min(consumed, input.length)
    return out.subarray(0, n)
  }
}

function concat(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** 16-bit PCM WAV, the format Whisper and every decoder understand. */
function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}
