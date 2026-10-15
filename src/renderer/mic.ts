import { resolveAsset } from './assets'

export interface MicOptions {
  /** one utterance: 16 kHz mono 16-bit WAV, how long it was, and whether it began while she was talking */
  onUtterance(wav: ArrayBuffer, ms: number, bargedIn: boolean): void
  /** input level (RMS 0..1) and whether speech is being collected right now */
  onLevel?(rms: number, speaking: boolean): void
  /** they have been talking over her for BARGE_MS: the moment to stop her line */
  onBargeIn?(): void
  onError?(message: string): void
}

export interface Mic {
  start(): Promise<void>
  stop(): void
  /** deaf: the closed-mic fallback while she talks (DESKMATE_BARGE_IN=0) */
  setBlocked(blocked: boolean): void
  /** she is talking: the mic stays open, but only a voice well above what is left of hers, for BARGE_MS, counts */
  setDucked(ducked: boolean): void
  readonly active: boolean
}

const RATE = 16000
const PRE_ROLL_MS = 400 // kept from before speech was detected, so the first syllable survives
const START_MS = 120 // this long above the threshold starts an utterance
const BARGE_MS = 400 // ... or this long while she is talking, which also cuts her off
const END_MS = 800 // this long below it ends one
const MIN_SPEECH_MS = 450 // shorter than this is a cough or a click
const MAX_UTTERANCE_MS = 25_000
const DUCK_CALIBRATE_MS = 600 // the first moments of her line: measure her echo, decide nothing yet
const DUCK_FLOOR = 0.03 // while she talks, nothing quieter than this is a voice (her own echo peaks near 0.025) ...
const DUCK_RATIO = 2.5 // ... nor anything less than this many times her measured echo
const DUCK_CREEP = 1.15 // after that, the measured echo may rise this much per chunk at most: a voice ramps up faster

/**
 * Hands-free listening: the mic streams through an AudioWorklet into a small energy-based voice activity
 * detector; each utterance is cut at the pause and shipped to the main process as WAV for Whisper.
 *
 * While she talks the detector can stay open ("ducked"): echo cancellation removes most of her voice from the mic,
 * the bar is raised well above what is left, and a voice that stays over that bar for BARGE_MS is them talking over
 * her, which both interrupts her and starts the next utterance.
 */
export function createMic(opts: MicOptions): Mic {
  let ctx: AudioContext | null = null
  let stream: MediaStream | null = null
  let node: AudioWorkletNode | null = null
  let blocked = false
  let ducked = false
  let active = false

  // VAD state
  let preRoll: Float32Array[] = []
  let preRollSamples = 0
  let utterance: Float32Array[] = []
  let utteranceSamples = 0
  let inSpeech = false
  let bargedIn = false // the current utterance began while she was talking
  let speechRunMs = 0
  let silenceRunMs = 0
  let noise = 0.004
  let echo = 0 // what comes back of her voice through the mic while she talks (after echo cancellation)
  let duckedForMs = 0
  const duckStats = { max: 0, sum: 0, n: 0, barge: false }

  function reset(): void {
    preRoll = []
    preRollSamples = 0
    utterance = []
    utteranceSamples = 0
    inSpeech = false
    bargedIn = false
    speechRunMs = 0
    silenceRunMs = 0
  }

  function duckBar(): number {
    return Math.max(DUCK_FLOOR, echo * DUCK_RATIO, noise * 5)
  }

  function onChunk(chunk: Float32Array): void {
    if (blocked) {
      if (inSpeech || preRoll.length) {
        reset()
        opts.onLevel?.(0, false)
      }
      return
    }
    let sum = 0
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
    const rms = Math.sqrt(sum / chunk.length)
    const chunkMs = (chunk.length / RATE) * 1000
    const threshold = ducked ? duckBar() : Math.max(0.01, noise * 3.2)
    const loud = rms > threshold
    if (ducked) {
      duckedForMs += chunkMs
      duckStats.max = Math.max(duckStats.max, rms)
      duckStats.sum += rms
      duckStats.n++
      // Her echo: the peak of her first moments (nobody has had time to answer her yet), then whatever stays under
      // the bar, but only creeping up: left free, each sound just under the bar would lift it, and a voice that starts
      // quietly, as every voice does, would never catch it.
      if (!inSpeech) {
        if (duckedForMs <= DUCK_CALIBRATE_MS) echo = Math.max(echo * 0.995, rms)
        else if (!loud) echo = Math.max(echo * 0.995, Math.min(rms, echo * DUCK_CREEP))
      }
    } else if (!inSpeech && !loud) {
      noise = noise * 0.95 + rms * 0.05 // follow the room while nobody talks
    }
    opts.onLevel?.(rms, inSpeech)

    if (!inSpeech) {
      preRoll.push(chunk)
      preRollSamples += chunk.length
      while (preRollSamples > (RATE * PRE_ROLL_MS) / 1000 && preRoll.length > 1) preRollSamples -= preRoll.shift()!.length
      const calibrating = ducked && duckedForMs <= DUCK_CALIBRATE_MS
      if (loud && !calibrating) speechRunMs += chunkMs
      // Over her voice a breath between words does not reset the count, it only leaks.
      else speechRunMs = ducked ? Math.max(0, speechRunMs - chunkMs * 1.5) : 0
      if (speechRunMs >= (ducked ? BARGE_MS : START_MS)) {
        inSpeech = true
        bargedIn = ducked
        utterance = [...preRoll]
        utteranceSamples = preRollSamples
        silenceRunMs = 0
        if (ducked) {
          duckStats.barge = true
          opts.onBargeIn?.()
        }
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
      const overHer = bargedIn
      reset()
      if (speechMs >= MIN_SPEECH_MS) opts.onUtterance(encodeWav(samples, RATE), Math.round(durationMs), overHer)
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
      opts.onLevel?.(0, false)
    },
    setBlocked(b: boolean) {
      blocked = b
      if (b) reset()
    },
    setDucked(d: boolean) {
      if (d === ducked) return
      ducked = d
      if (d) {
        duckedForMs = 0
        echo = noise
        duckStats.max = 0
        duckStats.sum = 0
        duckStats.n = 0
        duckStats.barge = false
      } else if (duckStats.n) {
        // One line per line of hers, so the bar can be judged against her echo on any machine from the log.
        console.log(
          `[mic] while she talked: her echo peaked at ${duckStats.max.toFixed(3)}, averaged ${(duckStats.sum / duckStats.n).toFixed(3)}; the bar was ${duckBar().toFixed(3)}${duckStats.barge ? '; they talked over her' : ''}`
        )
      }
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
