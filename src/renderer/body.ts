import type { Pose } from './dance'

/**
 * Whole-body poses for a 3D character on the desktop: walking across the screen, pointing at something, sitting on
 * a window's top edge, sleeping, and dangling while carried. Pure functions of time and target, blended over the idle
 * pose by the renderer. Angles are radians on VRM's normalized humanoid, which faces the camera (+Z):
 * screen right is the character's left (+X), a thigh forward is negative X, a knee bend is positive X.
 */

const v = (x = 0, y = 0, z = 0): { x: number; y: number; z: number } => ({ x, y, z })
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x))

/** A walk cycle, three-quarters turned toward where she is going. */
export function walkPose(t: number, facing: number): Pose {
  const phase = t * Math.PI * 2 * 1.6 // steps per second
  const s = Math.sin(phase)
  const kneeL = Math.max(0, Math.sin(phase + 1.2)) * 0.9
  const kneeR = Math.max(0, Math.sin(phase + 1.2 + Math.PI)) * 0.9
  const bob = Math.abs(Math.cos(phase)) * 0.012
  return {
    hipsY: -0.01 + bob,
    hips: v(0, 0.08 * s, 0.03 * s),
    spine: v(0.05, -0.06 * s, 0),
    chest: v(0.02, -0.05 * s, 0),
    neck: v(0, -facing * 0.2, 0),
    head: v(0.04, -facing * 0.15, 0),
    armL: { swing: 0.45 * s, out: 0, raise: 0.12 },
    armR: { swing: -0.45 * s, out: 0, raise: 0.12 },
    elbowL: 0.35 + 0.15 * Math.max(0, s),
    elbowR: 0.35 + 0.15 * Math.max(0, -s),
    turn: facing * 0.85,
    legL: { thigh: -0.5 * s, knee: kneeL, out: 0 },
    legR: { thigh: 0.5 * s, knee: kneeR, out: 0 }
  }
}

/**
 * Pointing: the arm on the target's side comes up toward it (screen right is her left arm), the body and head turn a
 * little that way. dx, dy: target direction from her shoulder in screen terms (x right, y up), any length.
 */
export function pointPose(t: number, dx: number, dy: number, armDown: number): Pose {
  const facing = dx >= 0 ? 1 : -1
  const elevation = clamp(Math.atan2(dy, Math.abs(dx) + 1e-3), -0.7, 1.1)
  const breath = Math.sin(t * 1.4) * 0.5 + 0.5
  const arm = { swing: -0.35, out: 0, raise: armDown + elevation }
  const rest = { swing: 0.05, out: 0, raise: 0.05 }
  return {
    hipsY: 0,
    hips: v(0, facing * 0.12, 0),
    spine: v(0.01 * breath, facing * 0.1, -facing * 0.04),
    chest: v(0.02 * breath, facing * 0.08, 0),
    neck: v(-elevation * 0.15, facing * 0.25, 0),
    head: v(-elevation * 0.2, facing * 0.2, -facing * 0.05),
    armL: facing > 0 ? arm : rest,
    armR: facing > 0 ? rest : arm,
    elbowL: facing > 0 ? 0.05 : 0.3,
    elbowR: facing > 0 ? 0.3 : 0.05,
    turn: facing * 0.3
  }
}

/** Sitting on an edge: thighs forward, calves hanging, hands beside the hips, legs swinging idly. */
export function sitPose(t: number): Pose {
  const swingL = Math.sin(t * 1.3) * 0.18
  const swingR = Math.sin(t * 1.3 + 1.7) * 0.18
  const breath = Math.sin(t * 1.4) * 0.5 + 0.5
  return {
    hipsY: 0,
    hips: v(0, 0, 0),
    spine: v(0.06 + 0.01 * breath, 0, 0),
    chest: v(0.03 + 0.02 * breath, 0, 0),
    neck: v(0.05, 0.08 * Math.sin(t * 0.4), 0),
    head: v(0.04, 0.1 * Math.sin(t * 0.4 + 1), 0.06 * Math.sin(t * 0.5)),
    armL: { swing: -0.35, out: 0.08, raise: 0.02 },
    armR: { swing: -0.35, out: 0.08, raise: 0.02 },
    elbowL: 0.45,
    elbowR: 0.45,
    turn: 0,
    legL: { thigh: -1.45, knee: 1.35 + swingL, out: 0.08 },
    legR: { thigh: -1.45, knee: 1.35 + swingR, out: 0.08 }
  }
}

/** Asleep: the head drops, breathing slows; on top of standing or sitting. */
export function sleepPose(base: Pose, t: number): Pose {
  const breath = Math.sin(t * 0.8) * 0.5 + 0.5
  return {
    ...base,
    spine: v(base.spine.x + 0.12 + 0.02 * breath, 0, 0),
    chest: v(base.chest.x + 0.04 * breath, 0, 0),
    neck: v(0.25, 0, 0.05),
    head: v(0.3, 0, 0.18),
    armL: { swing: base.armL.swing, out: base.armL.out, raise: 0 },
    armR: { swing: base.armR.swing, out: base.armR.out, raise: 0 },
    turn: 0
  }
}

/**
 * Carried by the cursor: the body swings like a pendulum under where she is held (sway, from the drag velocity,
 * smoothed by the caller), legs trail and kick a little, arms come up.
 */
export function danglePose(t: number, sway: number): Pose {
  const kick = Math.sin(t * 7) * 0.12
  return {
    hipsY: 0.01,
    hips: v(0, 0, clamp(sway, -0.6, 0.6)),
    spine: v(-0.05, 0, clamp(-sway * 0.3, -0.3, 0.3)),
    chest: v(-0.04, 0, 0),
    neck: v(-0.1, 0, clamp(-sway * 0.4, -0.3, 0.3)),
    head: v(-0.12, 0, 0),
    armL: { swing: -0.2, out: 0.1, raise: 0.5 + kick },
    armR: { swing: -0.2, out: 0.1, raise: 0.5 - kick },
    elbowL: 0.6,
    elbowR: 0.6,
    turn: 0,
    legL: { thigh: 0.15 + kick, knee: 0.35, out: 0.05 },
    legR: { thigh: 0.1 - kick, knee: 0.45, out: 0.05 }
  }
}

/**
 * How much of a gesture shows at progress k (0..1): eases in over the first quarter, holds, eases out over the last
 * third, so a stretch or a glance never pops.
 */
export function gestureWeight(k: number): number {
  const smooth = (x: number): number => x * x * (3 - 2 * x)
  if (k <= 0 || k >= 1) return 0
  if (k < 0.25) return smooth(k / 0.25)
  if (k > 0.67) return smooth((1 - k) / 0.33)
  return 1
}

/**
 * A stretch: arms up over the head, a lean back with a slow side-to-side reach, eyes to the ceiling. Legs stay as
 * they are in `base`, so it works standing or sitting; standing, she also rises a little onto her toes.
 */
export function stretchPose(base: Pose, k: number): Pose {
  const side = Math.sin(k * Math.PI * 2) * 0.1
  return {
    ...base,
    hipsY: base.legL ? base.hipsY : base.hipsY + 0.008,
    spine: v(-0.1, 0, side),
    chest: v(-0.08, 0, side * 0.6),
    neck: v(-0.12, 0, 0),
    head: v(-0.18, 0, -side * 0.5),
    armL: { swing: -0.15, out: 0.05, raise: 2.85 },
    armR: { swing: -0.15, out: 0.05, raise: 2.85 },
    elbowL: 0.35,
    elbowR: 0.35,
    turn: base.turn * 0.5
  }
}

/** A yawn: the head tips back a little and one hand comes up toward the mouth (the renderer opens the mouth). */
export function yawnPose(base: Pose, k: number): Pose {
  const tip = Math.sin(Math.min(1, k * 1.4) * Math.PI) * 0.5 + 0.5
  return {
    ...base,
    spine: v(base.spine.x - 0.04, base.spine.y, base.spine.z),
    neck: v(-0.08 * tip, base.neck.y, 0.04),
    head: v(-0.16 * tip, base.head.y, 0.08),
    armR: { swing: -1.15, out: 0.25, raise: 0.35 },
    elbowR: 2.1
  }
}

/** A glance: neck and head turn toward a spot (dx, dy from her head in screen terms, x right, y up); the body stays. */
export function glancePose(base: Pose, dx: number, dy: number): Pose {
  const nx = clamp(dx / 400, -1, 1)
  const ny = clamp(dy / 400, -1, 1)
  return {
    ...base,
    neck: v(base.neck.x - ny * 0.08, base.neck.y + nx * 0.22, base.neck.z),
    head: v(base.head.x - ny * 0.12, base.head.y + nx * 0.25, base.head.z - nx * 0.04)
  }
}
