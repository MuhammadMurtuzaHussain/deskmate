MMD (PMX/PMD/VMD) support vendored from three.js r170 (MIT, see LICENSE), the last release that shipped
MMDLoader, MMDAnimationHelper, CCDIKSolver, MMDPhysics and mmdparser in `examples/jsm`. Relative imports
were rewritten to this folder; everything else is unmodified. Physics (MMDPhysics) needs a global `Ammo`
and is not enabled by Deskmate.
