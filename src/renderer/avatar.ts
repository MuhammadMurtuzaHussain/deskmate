import type { Anchors, BodyState, DanceStyle, Emotion } from '../shared/types'

/** Screen-space rectangle of the character, in CSS pixels. */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * What the UI needs from a character on screen, whatever renders her (Live2D or VRM).
 * Audio playback for speech belongs to the avatar because the mouth is driven from it.
 */
export interface Avatar {
  readonly kind: 'live2d' | 'vrm' | 'mmd' | 'mesh'
  readonly capabilities: { dance: boolean; outfits: boolean }
  load(): Promise<void>
  layout(): void
  getBounds(): Bounds | null
  setExpression(emotion: Emotion): void
  /** Plays the audio with lip sync. Resolves true when playback finished (or was cut short), false if it could not start. */
  speak(url: string, mime: string): Promise<boolean>
  /** Stops the line she is saying: the audio and the lip sync; the pending speak() resolves. */
  interrupt(): void
  /** Mouth value 0..1 for the browser-voice fallback (no audio stream to analyse). */
  setFakeMouth(value: number): void
  /** Physics impulse (taps, drags, replies). */
  kick(strength: number): void
  /** Pointer position in CSS pixels, for look-at. */
  pointerMove(x: number, y: number): void
  dance(on: boolean, style?: DanceStyle): void
  isDancing(): boolean
  /** Walking, pointing, sitting, sleeping (optional: a renderer without it just stays idle). */
  setBody?(state: BodyState): void
  /** Being carried by the cursor: horizontal drag velocity in px/s, or null when let go. */
  setCarried?(velocity: number | null): void
  /** Head, shoulder, hips and feet in CSS pixels, for placing her window against things on screen. */
  anchors?(): Anchors | null
  /** Switches to the next outfit; resolves with its name, or null when the character has none. */
  nextOutfit(): Promise<string | null>
  destroy(): void
}
