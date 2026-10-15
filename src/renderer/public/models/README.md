# Local Live2D models

Drop a model folder here, for example:

    models/yuki/yuki.model3.json
    models/yuki/yuki.moc3
    models/yuki/yuki.physics3.json
    models/yuki/textures/...
    models/yuki/expressions/*.exp3.json
    models/yuki/motions/*.motion3.json

then create `character/yuki/character.json` with `"model": "/models/yuki/yuki.model3.json"` (copy `character/nicole/` as a template) plus a `persona.md`, and map the
emotion names to the expression names listed in that model's `FileReferences.Expressions`.

Jiggle lives in the model, not the app: it is the model's `physics3.json` (hair, chest, skirt rigs).
The app only drives the inputs (body angle, head angle) that make those rigs move. A model without
a chest rig will not bounce no matter what the config says.

Where rigged models come from: Live2D's own sample models (free, modest), nizima (Live2D's official
marketplace), and Booth.pm, where commissioned VTuber models are sold, often with chest and hair
physics. Check each model's license before you use it beyond your own desk.
