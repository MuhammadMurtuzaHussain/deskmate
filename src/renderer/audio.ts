/**
 * Plays an audio URL and reports its loudness every frame, so a 3D mouth can follow the voice.
 * One shared AudioContext; each utterance gets its own element and analyser.
 */
export interface Speaker {
  /** Resolves true when playback finished or was stopped, false if it could not start. */
  speak(url: string): Promise<boolean>
  /** 0..1 loudness of whatever is playing right now (0 when silent). */
  level(): number
  /** Cuts the current line; its speak() resolves at once. */
  stop(): void
}

export function createSpeaker(): Speaker {
  let ctx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let data: Uint8Array<ArrayBuffer> | null = null
  let current: { audio: HTMLAudioElement; done: (ok: boolean) => void } | null = null

  function stop(): void {
    const c = current
    current = null
    if (!c) return
    c.audio.pause()
    c.done(true)
  }

  return {
    speak(url: string): Promise<boolean> {
      return new Promise((resolve) => {
        try {
          stop()
          ctx ??= new AudioContext()
          const audio = new Audio(url)
          const src = ctx.createMediaElementSource(audio)
          const an = ctx.createAnalyser()
          an.fftSize = 512
          src.connect(an)
          an.connect(ctx.destination)
          analyser = an
          data = new Uint8Array(an.fftSize) as Uint8Array<ArrayBuffer>
          let settled = false
          const done = (ok: boolean): void => {
            if (settled) return
            settled = true
            if (analyser === an) {
              analyser = null
              data = null
            }
            if (current?.audio === audio) current = null
            try {
              src.disconnect()
              an.disconnect()
            } catch {
              /* already gone */
            }
            resolve(ok)
          }
          current = { audio, done }
          audio.onended = () => done(true)
          audio.onerror = () => done(false)
          void ctx.resume()
          audio.play().catch((err) => {
            console.warn('[audio] play failed', err)
            done(false)
          })
        } catch (err) {
          console.warn('[audio] speak failed', err)
          resolve(false)
        }
      })
    },
    level(): number {
      if (!analyser || !data) return 0
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const d = (data[i] - 128) / 128
        sum += d * d
      }
      const rms = Math.sqrt(sum / data.length)
      return Math.min(1, Math.max(0, (rms - 0.015) * 9))
    },
    stop
  }
}
