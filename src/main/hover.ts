/**
 * When to go for the pointer: it has to stay within reach of her head for `hoverMs` without a break, and swats are at
 * least `everyMs` apart. Pure, so the timing is testable; Body feeds it the pointer every poll.
 */
export class HoverSwat {
  private since = 0
  private last = -Infinity
  private readonly hoverMs: number
  private readonly everyMs: number

  constructor(hoverMs = 2000, everyMs = 40_000) {
    this.hoverMs = hoverMs
    this.everyMs = everyMs
  }

  /** The pointer is (or is not) near her head at `now`; true when she should swat at it now. */
  update(near: boolean, now: number): boolean {
    if (!near) {
      this.since = 0
      return false
    }
    if (!this.since) this.since = now
    if (now - this.since < this.hoverMs || now - this.last < this.everyMs) return false
    this.last = now
    this.since = 0
    return true
  }

  /** She got busy, moved, or was picked up: the hover starts over. */
  reset(): void {
    this.since = 0
  }
}

/** Within reach: about half her head-to-hips height around her head, never less than 70 px. */
export function nearHead(pointer: { x: number; y: number }, head: { x: number; y: number }, hipsY: number): boolean {
  const reach = Math.max(70, (hipsY - head.y) * 0.5)
  return Math.hypot(pointer.x - head.x, pointer.y - head.y) < reach
}
