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
    armR: { swing: -0.8, out: 0, raise: -0.3 },
    elbowR: 2.3
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

/**
 * Lying on her front along a window's top edge, head toward you, chin propped on her hands, calves kicking slowly
 * behind her. The body pivots forward about the hips (so her hips stay where the window's edge is), the back arches to
 * bring her face up, the upper arms swing forward and down to the "floor" and the forearms come back up under her
 * chin. Turned three-quarters so the kicking legs show. `kick` 0 holds the legs still (asleep).
 */
export function liePose(t: number, kick = 1): Pose {
  const kL = Math.sin(t * 1.7) * 0.42 * kick
  const kR = Math.sin(t * 1.7 + Math.PI * 0.85) * 0.42 * kick
  const breath = Math.sin(t * 1.3) * 0.5 + 0.5
  const tilt = Math.sin(t * 0.45) * 0.12
  return {
    hipsY: 0,
    hips: v(1.48, 0, 0),
    spine: v(-0.4 - 0.015 * breath, 0, 0),
    chest: v(-0.36 - 0.02 * breath, 0, 0),
    neck: v(-0.22, 0.05 * Math.sin(t * 0.3), tilt * 0.4),
    head: v(-0.34 + 0.03 * Math.sin(t * 0.8), 0.06 * Math.sin(t * 0.37 + 1), tilt),
    armL: { swing: -1.37, out: 0.05, raise: -0.25 },
    armR: { swing: -1.37, out: 0.05, raise: -0.25 },
    elbowL: 2.4,
    elbowR: 2.4,
    turn: 0.55,
    legL: { thigh: -0.04, knee: 1.25 + kL, out: 0.07 },
    legR: { thigh: -0.04, knee: 1.25 + kR, out: 0.07 }
  }
}

/** Dozing off lying down: the head sinks onto her hands, the kicking stops, breathing slows. */
export function lieSleepPose(t: number): Pose {
  const base = liePose(t, 0.08)
  const breath = Math.sin(t * 0.8) * 0.5 + 0.5
  return {
    ...base,
    spine: v(-0.2 + 0.015 * breath, 0, 0),
    chest: v(-0.2 + 0.02 * breath, 0, 0),
    neck: v(-0.05, 0, 0.08),
    head: v(0.12, 0.1, 0.22),
    legL: { thigh: -0.02, knee: 0.9, out: 0.08 },
    legR: { thigh: -0.02, knee: 1.15, out: 0.06 }
  }
}

/**
 * Peeking in from behind a screen edge: she stands mostly past the edge (`side` 1 right, -1 left) and leans back in
 * toward the middle of the screen, head tilted right over, the near hand up by her face as if holding the edge. The lean
 * breathes in and out a little, as if she keeps checking.
 */
export function peekPose(t: number, side: number): Pose {
  const s = side >= 0 ? 1 : -1
  const lean = 0.82 + 0.18 * (Math.sin(t * 0.9) * 0.5 + 0.5) + 0.06 * Math.sin(t * 2.3)
  // the near hand up by her face, with a little wave every few seconds
  const wave = Math.max(0, Math.sin(t * 0.7)) ** 6 * Math.sin(t * 11)
  const hand = { swing: -0.55, out: -0.35 + 0.25 * wave, raise: 1.95 + 0.12 * wave }
  const hang = { swing: 0.05, out: 0, raise: 0.08 }
  return {
    hipsY: 0,
    hips: v(0, -s * 0.12, s * 0.1 * lean),
    spine: v(0.04, -s * 0.06, s * 0.2 * lean),
    chest: v(0.02, -s * 0.05, s * 0.16 * lean),
    neck: v(0.02, -s * 0.12, s * 0.12 * lean),
    head: v(0.04 + 0.03 * Math.sin(t * 1.1), -s * 0.18, s * (0.32 + 0.06 * Math.sin(t * 0.7))),
    // the near arm is the one toward the middle of the screen: her right at the right edge
    armL: s > 0 ? hang : hand,
    armR: s > 0 ? hand : hang,
    elbowL: s > 0 ? 0.25 : 1.75,
    elbowR: s > 0 ? 1.75 : 0.25,
    turn: -s * 0.3,
    legL: { thigh: 0, knee: 0.05, out: s > 0 ? 0.04 : 0.12 },
    legR: { thigh: 0, knee: 0.05, out: s > 0 ? 0.12 : 0.04 }
  }
}

/**
 * A swat at the pointer: the arm on its side comes up above it, then pats down at it quickly and stays a beat, while
 * her head and body turn toward it. dx, dy: from her head to the pointer in screen terms (x right, y up). Lying, only the
 * forearm comes up off the window and the head turns.
 */
export function swatPose(base: Pose, k: number, dx: number, dy: number, armDown: number, lying = false): Pose {
  const s = dx >= 0 ? 1 : -1
  const nx = clamp(dx / 300, -1, 1)
  const ny = clamp(dy / 300, -1, 1)
  // up and over it until 40 %, a quick pat down by 52 %, then held (the caller's weight eases it out)
  const smooth = (x: number): number => x * x * (3 - 2 * x)
  const pat = k < 0.4 ? 0 : k < 0.52 ? smooth((k - 0.4) / 0.12) : 1
  const head = {
    neck: v(base.neck.x - ny * 0.08, base.neck.y + nx * 0.2, base.neck.z),
    head: v(base.head.x - ny * 0.12, base.head.y + nx * 0.25, base.head.z - nx * 0.06)
  }
  if (lying) {
    const lift = { swing: -2.55 + pat * 0.35, out: -0.1, raise: 0.1 }
    return {
      ...base,
      ...head,
      armL: s > 0 ? lift : base.armL,
      armR: s > 0 ? base.armR : lift,
      elbowL: s > 0 ? 0.9 + pat * 0.6 : base.elbowL,
      elbowR: s > 0 ? base.elbowR : 0.9 + pat * 0.6
    }
  }
  const elevation = clamp(Math.atan2(dy, Math.abs(dx) + 1e-3), -0.6, 1.2)
  const arm = { swing: -0.55 + pat * 0.2, out: -0.25, raise: armDown + elevation + 0.45 - pat * 0.75 }
  return {
    ...base,
    ...head,
    spine: v(base.spine.x + 0.04 * pat, base.spine.y + s * 0.08, base.spine.z - s * 0.06),
    chest: v(base.chest.x, base.chest.y + s * 0.06, base.chest.z),
    armL: s > 0 ? arm : base.armL,
    armR: s > 0 ? base.armR : arm,
    elbowL: s > 0 ? 0.7 - pat * 0.45 : base.elbowL,
    elbowR: s > 0 ? base.elbowR : 0.7 - pat * 0.45,
    turn: base.turn + s * 0.12
  }
}

/** A bored sigh: shoulders and head sink, then come back up a little; arms go heavy. Legs stay as in `base`. */
export function sighPose(base: Pose, k: number): Pose {
  const sink = Math.sin(Math.min(1, k * 1.3) * Math.PI)
  return {
    ...base,
    spine: v(base.spine.x + 0.1 * sink, base.spine.y, base.spine.z),
    chest: v(base.chest.x + 0.08 * sink, base.chest.y, base.chest.z),
    neck: v(base.neck.x + 0.12 * sink, base.neck.y, base.neck.z + 0.05),
    head: v(base.head.x + 0.16 * sink, base.head.y - 0.1, base.head.z + 0.12),
    armL: { ...base.armL, raise: base.armL.raise * (1 - 0.5 * sink) },
    armR: { ...base.armR, raise: base.armR.raise * (1 - 0.5 * sink) }
  }
}

/** Bored, all the time she is: a slouch, the head propped over to one side, a slow restless sway. */
export function slumpPose(base: Pose, t: number): Pose {
  const sway = Math.sin(t * 0.35)
  return {
    ...base,
    spine: v(base.spine.x + 0.07, base.spine.y + 0.04 * sway, base.spine.z),
    chest: v(base.chest.x + 0.05, base.chest.y, base.chest.z),
    neck: v(base.neck.x + 0.06, base.neck.y + 0.08 * sway, base.neck.z + 0.06),
    head: v(base.head.x + 0.08, base.head.y + 0.1 * sway, base.head.z + 0.14)
  }
}
