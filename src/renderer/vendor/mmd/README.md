MMD (PMX/PMD/VMD) support vendored from three.js r170 (MIT, see LICENSE), the last release that shipped
MMDLoader, MMDAnimationHelper, CCDIKSolver, MMDPhysics and mmdparser in `examples/jsm`. Relative imports
were rewritten to this folder; everything else is unmodified except as noted below. Physics (MMDPhysics)
needs a global `Ammo` and is not enabled by Deskmate.

The upstream `console.warn` deprecation notices in the MMDLoader, MMDAnimationHelper and MMDPhysics
constructors ("deprecated and will be removed with r172") were removed: they are misleading here, since these
files are vendored precisely because three r186 no longer ships them, and they printed on every character load.
