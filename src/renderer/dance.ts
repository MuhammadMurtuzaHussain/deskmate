import type { DanceStyle } from '../shared/types'

export interface V3 {
  x: number
  y: number
  z: number
}

/**
 * A body pose for one frame, in renderer-neutral terms so the VRM and MMD avatars can both perform it.
 * Rotations are radians relative to the character's rest pose. Arm "raise" is how far the upper arm comes up
 * from hanging straight down (0 = hanging, ~1.6 = horizontal, ~3 = straight up); "out" rotates it forward/back
 * around the vertical axis; "swing" rotates it around the body's side axis. Elbow "bend" is positive.
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
  /** legs, for walking and sitting (absent = standing straight): thigh forward (negative) / back, knee bend */
  legL?: Leg
  legR?: Leg
}

export interface Leg {
  thigh: number
  knee: number
  /** sideways spread */
  out: number
}

const STRAIGHT: Leg = { thigh: 0, knee: 0, out: 0 }
const lerpLeg = (a: Leg | undefined, b: Leg | undefined, t: number): Leg => {
  const x = a ?? STRAIGHT
  const y = b ?? STRAIGHT
  return { thigh: x.thigh + (y.thigh - x.thigh) * t, knee: x.knee + (y.knee - x.knee) * t, out: x.out + (y.out - x.out) * t }
}

const v = (x = 0, y = 0, z = 0): V3 => ({ x, y, z })
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const lerp3 = (a: V3, b: V3, t: number): V3 => v(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t))

export function blendPose(a: Pose, b: Pose, t: number): Pose {
  return {
    hipsY: lerp(a.hipsY, b.hipsY, t),
    hips: lerp3(a.hips, b.hips, t),
    spine: lerp3(a.spine, b.spine, t),
    chest: lerp3(a.chest, b.chest, t),
    neck: lerp3(a.neck, b.neck, t),
    head: lerp3(a.head, b.head, t),
    armL: { swing: lerp(a.armL.swing, b.armL.swing, t), out: lerp(a.armL.out, b.armL.out, t), raise: lerp(a.armL.raise, b.armL.raise, t) },
    armR: { swing: lerp(a.armR.swing, b.armR.swing, t), out: lerp(a.armR.out, b.armR.out, t), raise: lerp(a.armR.raise, b.armR.raise, t) },
    elbowL: lerp(a.elbowL, b.elbowL, t),
    elbowR: lerp(a.elbowR, b.elbowR, t),
    turn: lerp(a.turn, b.turn, t),
    legL: a.legL || b.legL ? lerpLeg(a.legL, b.legL, t) : undefined,
    legR: a.legR || b.legR ? lerpLeg(a.legR, b.legR, t) : undefined
  }
}

/** Standing idle: breathing, a slow weight shift, and the damped impulse `k` from taps and replies. */
export function idlePose(t: number, sway: number, k: number): Pose {
  const breath = Math.sin(t * 1.4) * 0.5 + 0.5
  return {
    hipsY: 0,
    hips: v(0, 0.03 * sway * Math.sin(t * 0.5), 0.025 * sway * Math.sin(t * 0.7) + 0.08 * k),
    spine: v(0.01 * breath + 0.05 * k, 0.02 * sway * Math.sin(t * 0.6 + 1), -0.02 * sway * Math.sin(t * 0.7) - 0.05 * k),
    chest: v(0.025 * breath + 0.04 * k, 0, 0),
    neck: v(0.02 * Math.sin(t * 0.9) + 0.06 * k, 0.05 * sway * Math.sin(t * 0.4 + 2), 0.02 * sway * Math.sin(t * 0.8)),
    head: v(0.03 * Math.sin(t * 1.1 + 1), 0, 0.03 * sway * Math.sin(t * 0.9 + 1) + 0.05 * k),
    armL: { swing: 0.05 * Math.sin(t * 0.8), out: 0, raise: 0.03 * Math.sin(t * 0.8) },
    armR: { swing: 0.05 * Math.sin(t * 0.8 + 1), out: 0, raise: 0.03 * Math.sin(t * 0.8 + 1) },
    elbowL: 0.25 + 0.05 * breath,
    elbowR: 0.25 + 0.05 * breath,
    turn: 0
  }
}

/** 0→1→0 over a cycle, for swapping sides smoothly. */
const swapCurve = (beats: number, period: number): number => 0.5 - 0.5 * Math.cos((beats / period) * Math.PI * 2)
/** Picks a phrase index that changes every `len` beats, so a dance has sections instead of one loop. */
const phrase = (beats: number, len: number, count: number): number => Math.floor(beats / len) % count

/** Upbeat groove: bounce, hip pops, arm waves and claps, in 8-beat phrases. */
function groove(beats: number): Pose {
  const beat = beats * Math.PI
  const bounce = Math.abs(Math.sin(beat))
  const swing = Math.sin(beat / 2)
  const ph = phrase(beats, 8, 3)
  const base: Pose = {
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
  if (ph === 1) {
    // arms up, hands waving overhead
    base.armL = { swing: -0.3, out: 0.3 * swing, raise: 2.4 + 0.2 * swing }
    base.armR = { swing: -0.3, out: -0.3 * swing, raise: 2.4 - 0.2 * swing }
    base.elbowL = 0.6 + 0.3 * bounce
    base.elbowR = 0.6 + 0.3 * (1 - bounce)
    base.hips.z = 0.2 * swing
  } else if (ph === 2) {
    // side-to-side step with a shoulder lean
    base.turn = 0.4 * swing
    base.spine.z = -0.14 * swing
    base.armL = { swing: 0.2 * swing, out: 0.4, raise: 0.9 + 0.3 * bounce }
    base.armR = { swing: -0.2 * swing, out: 0.4, raise: 0.9 + 0.3 * (1 - bounce) }
    base.elbowL = 1.0
    base.elbowR = 1.0
  }
  return base
}

/** Slow and sensual: hip figure-eights, a body wave travelling up the spine, hands tracing from hip to hair. */
function slow(beats: number): Pose {
  const w = (beats / 4) * Math.PI * 2 // one cycle per four beats
  const s = Math.sin(w)
  const c = Math.cos(w)
  const wave = (lag: number): number => Math.sin(w - lag)
  const swap = swapCurve(beats, 16) // which hand is up in the hair
  const ph = phrase(beats, 16, 2)
  const pose: Pose = {
    hipsY: -0.012 - 0.01 * Math.abs(Math.sin(w / 2)),
    hips: v(0.04 * s, 0.26 * s, 0.16 * c),
    spine: v(0.06 * wave(0.9), -0.14 * s, -0.1 * c),
    chest: v(0.08 * wave(1.7), -0.09 * s, -0.05 * c),
    neck: v(0.06 * wave(2.4), 0.14 * s, 0.05 * c),
    head: v(0.05 * wave(3.0), 0.12 * s, -0.14 * Math.sin(w / 2)),
    armL: { swing: -0.15 + 0.1 * s, out: 0.3, raise: lerp(0.3 + 0.12 * c, 2.6 + 0.1 * s, 1 - swap) },
    armR: { swing: -0.15 - 0.1 * s, out: 0.3, raise: lerp(0.3 - 0.12 * c, 2.6 - 0.1 * s, swap) },
    elbowL: lerp(0.9, 2.2 + 0.15 * s, 1 - swap),
    elbowR: lerp(0.9, 2.2 - 0.15 * s, swap),
    turn: 0.35 * Math.sin(w / 2)
  }
  if (ph === 1) {
    // both hands slide up the body to the hair, hips keep circling, a slow turn
    const up = 0.5 + 0.5 * Math.sin(w / 2)
    pose.armL = { swing: -0.35 * up, out: 0.5, raise: 0.6 + 2.0 * up }
    pose.armR = { swing: -0.35 * up, out: 0.5, raise: 0.6 + 2.0 * up }
    pose.elbowL = 1.2 + 1.0 * up
    pose.elbowR = 1.2 + 1.0 * up
    pose.turn = 0.6 * Math.sin(w / 4)
    pose.head.x = -0.12 * up
  }
  return pose
}

/** A twirl with the arms lifting as she spins, settling into a pose at the end of each turn. */
function spin(beats: number, t: number): Pose {
  const beat = beats * Math.PI
  const spinAngle = t * 2.4
  const lift = 0.5 + 0.5 * Math.sin(beat / 2)
  return {
    hipsY: -0.015 * Math.abs(Math.sin(beat)),
    hips: v(0, 0, 0.05 * Math.sin(beat / 2)),
    spine: v(-0.04, 0, 0.03 * Math.sin(beat / 2)),
    chest: v(-0.03, 0, 0),
    neck: v(0.02, 0.2 * Math.sin(spinAngle), 0.06),
    head: v(0, 0, -0.08),
    armL: { swing: 0, out: 0.2 + 0.5 * lift, raise: 0.6 + 0.6 * lift },
    armR: { swing: 0, out: 0.2 + 0.5 * lift, raise: 0.6 + 0.6 * lift },
    elbowL: 0.35,
    elbowR: 0.35,
    turn: spinAngle
  }
}

export function dancePose(style: DanceStyle, t: number, bpm: number): Pose {
  const beats = (t * bpm) / 60
  if (style === 'slow') return slow(beats)
  if (style === 'spin') return spin(beats, t)
  return groove(beats)
}

/** Default tempo per style when the character does not set one. */
export function defaultBpm(style: DanceStyle): number {
  return style === 'slow' ? 70 : 124
}
