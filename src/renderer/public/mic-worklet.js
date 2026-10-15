// Runs on the audio thread: batches the mic's 128-sample blocks into ~64 ms chunks for the VAD in mic.ts.
class MicTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(1024)
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i]
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf)
          this.buf = new Float32Array(1024)
          this.n = 0
        }
      }
    }
    return true
  }
}
registerProcessor('mic-tap', MicTap)
