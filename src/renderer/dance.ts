import type { DanceStyle } from '../shared/types'

export interface V3 {
  x: number
  y: number
  z: number
}

/**
 * A body pose for one frame of a dance, expressed in renderer-neutral terms so the VRM and MMD avatars can
 * both perform it. Rotations are radians relative to the character's rest pose. Arm "raise" is how far the
 * upper arm comes up from hanging down (0 = hanging, ~1.6 = straight up); elbow "bend" is positive.
 */
export interface Pose {
  /** vertical offset of the hips as a fraction of body height (negative = crouch) */
  hipsY: number
  hips: V3
  spine: V3
  chest: V3
  neck: V3
  head: V3
  armL: { swing: number; out: number; raise: number }
  armR: { swing: number; out: number; raise: number }
  elbowL: number
  elbowR: number
  /** whole-body turn around the vertical axis */
  turn: number
}

const v = (x = 0, y = 0, z = 0): V3 => ({ x, y, z })

/** Smoothly alternates between 0 and 1 with a given period in beats (for swapping sides). */
function side(beats: number, period: number): number {
  return 0.5 - 0.5 * Math.cos((beats / period) * Math.PI * 2)
}

/**
 * Procedural choreography. `t` is seconds since the dance started, `bpm` the tempo.
 * groove: upbeat bounce. slow: slow hip sway with body rolls, one hand up in the hair. spin: a twirl.
 */
export function dancePose(style: DanceStyle, t: number, bpm: number): Pose {
  const bps = bpm / 60
  const beats = t * bps
  const beat = beats * Math.PI // half-beat phase: |sin| bounces twice per beat
  if (style === 'slow') {
    const w = (beats / 4) * Math.PI * 2 // one slow cycle per four beats
    const s = Math.sin(w)
    const c = Math.cos(w)
    const swap = side(beats, 16) // which hand is up
    return {
      hipsY: -0.01 - 0.008 * Math.abs(Math.sin(w / 2)),
      hips: v(0.03 * s, 0.22 * s, 0.14 * c),
      spine: v(0.05 * Math.sin(w - 0.9), -0.12 * s, -0.09 * c),
      chest: v(0.07 * Math.sin(w - 1.6), -0.08 * s, -0.04 * c),
      neck: v(0.05 * Math.sin(w - 2.2), 0.12 * s, 0.05 * c),
      head: v(0.04 * Math.sin(w - 2.8), 0.1 * s, -0.12 * Math.sin(w / 2)),
      armL: { swing: -0.15 + 0.1 * s, out: 0.25, raise: (1 - swap) * (1.35 + 0.1 * s) + swap * (0.25 + 0.12 * c) },
      armR: { swing: -0.15 - 0.1 * s, out: 0.25, raise: swap * (1.35 - 0.1 * s) + (1 - swap) * (0.25 - 0.12 * c) },
      elbowL: (1 - swap) * (2.3 + 0.15 * s) + swap * 0.9,
      elbowR: swap * (2.3 - 0.15 * s) + (1 - swap) * 0.9,
      turn: 0.35 * Math.sin(w / 2)
    }
  }
  if (style === 'spin') {
    const spin = t * 2.4 // rad/s
    const lift = 0.5 + 0.5 * Math.sin(beat / 2)
    return {
      hipsY: -0.015 * Math.abs(Math.sin(beat)),
      hips: v(0, 0, 0.05 * Math.sin(beat / 2)),
      spine: v(-0.04, 0, 0.03 * Math.sin(beat / 2)),
      chest: v(-0.03, 0, 0),
      neck: v(0.02, 0.2 * Math.sin(spin), 0.06),
      head: v(0, 0, -0.08),
      armL: { swing: 0, out: 0.2 + 0.5 * lift, raise: 0.55 + 0.35 * lift },
      armR: { swing: 0, out: 0.2 + 0.5 * lift, raise: 0.55 + 0.35 * lift },
      elbowL: 0.35,
      elbowR: 0.35,
      turn: spin
    }
  }
  // groove
  const bounce = Math.abs(Math.sin(beat))
  const swing = Math.sin(beat / 2)
  return {
    hipsY: -0.035 * bounce,
    hips: v(0.05 * bounce, 0.15 * swing, 0.14 * swing),
    spine: v(0.04 * Math.sin(beat), -0.12 * swing, -0.07 * swing),
    chest: v(-0.05 * bounce, -0.1 * swing, -0.06 * swing),
    neck: v(0.12 * bounce - 0.04, 0.2 * swing, 0.06 * swing),
    head: v(0.06 * Math.sin(beat + 1), 0.1 * swing, -0.1 * swing),
    armL: { swing: -0.2 - 0.6 * bounce, out: 0.1 * swing, raise: 0.35 + 0.35 * bounce },
    armR: { swing: -0.2 - 0.6 * (1 - bounce), out: -0.1 * swing, raise: 0.35 + 0.35 * (1 - bounce) },
    elbowL: 1.4 + 0.4 * bounce,
    elbowR: 1.4 + 0.4 * (1 - bounce),
    turn: 0.25 * Math.sin(beat / 4)
  }
}
