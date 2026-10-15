# Characters

A character is a folder with two files:

```
character/<id>/
  character.json   # model, expression mapping, physics, voices
  persona.md       # who she is, in plain English
```

The app ships with `mika` (Live2D's free sample model Haru, loaded from a CDN). Your own characters go next to it, or, for the installed app, in your user-data folder so they survive updates:

| OS | user-data folder |
|---|---|
| macOS | `~/Library/Application Support/deskmate/character/` |
| Windows | `%APPDATA%\deskmate\character\` |
| Linux | `~/.config/deskmate/character/` |

The tray menu has "Open characters folder" and "Open settings folder" shortcuts. Characters appear in the panel dropdown and the tray's Character submenu; each one has her own memory file.

## character.json

```json
{
  "id": "yuki",
  "name": "Yuki",
  "model": "/models/yuki/yuki.model3.json",
  "expressions": {
    "neutral": "", "happy": "smile", "flirty": "hearteyes", "surprised": "wow",
    "annoyed": "pout", "angry": "angry", "sad": "cry", "smug": "smirk", "shy": "blush"
  },
  "motions": { "idle": "Idle", "react": "Tap" },
  "physics": { "sway": 1.0, "bounce": 1.5 },
  "voice": { "kokoro": "af_heart", "speed": 1.0, "elevenlabs": "<voice id>", "say": "Samantha" }
}
```

- **model**: a `.model3.json` (Cubism 3/4). In a source checkout put the model folder under `src/renderer/public/models/` and use `/models/<folder>/<file>.model3.json`; in the installed app you can also use an absolute `file:///…` path or an `https://` URL.
- **expressions**: emotion → the `Name` of an entry in the model's `FileReferences.Expressions`. An empty string means "plain face". The brain picks one of these nine emotions for every line.
- **motions**: motion group names from the model's `FileReferences.Motions`. `react` plays on taps and replies; leave both as `Idle` if the model has no motions.
- **physics**: `sway` is the idle body movement that keeps hair, tail and chest rigs alive; `bounce` is the impulse on taps, drags and replies. Jiggle is a property of the model's `physics3.json`; the app only drives it.
- **voice**: which preset each voice provider uses for her.

## 3D characters (VRM, MMD, static meshes)

Set `"renderer"` in `character.json`:

| renderer | file | expressions | dance | outfits | notes |
|---|---|---|---|---|---|
| `vrm` | `.vrm` (0.x or 1.0) | built-in presets, no mapping needed | built-in choreographies + `.vrma` clips | `tint`, `hide`/`show`, or other `.vrm` files | VRoid Studio exports, VRoid Hub, Booth. Spring bones move hair and skirts. |
| `mmd` | `.pmx` | morphs, mapped via `morphs` (defaults cover 笑い / まばたき / あ … and ARKit names like `mouthSmileLeft`) | built-in choreographies + `.vmd` motions | material `hide`/`show` lists | Rigid-body physics (hair, skirt, chest) runs through Ammo when `physics.simulate` is not false. |
| `mesh` | `.obj` + `.mtl`, `.glb` | none | whole-body bob and spin | no | For models without a rig: she still talks (bubble + voice) and moves as a whole. |

Example (the bundled Victoria):

```json
{
  "id": "victoria", "name": "Victoria", "renderer": "vrm",
  "model": "/models/victoria/victoria_rubin.vrm",
  "dance": { "bpm": 124 },
  "animations": [{ "name": "wave", "file": "/models/victoria/wave.vrma" }],
  "outfits": [
    { "name": "noir", "tint": { "Tops": "#2b2733", "Shoes": "#1c1a22" } },
    { "name": "beach", "model": "/models/victoria/victoria_beach.vrm" }
  ],
  "camera": { "fov": 24, "yOffset": 0 }, "idle": { "armsDown": 1.18 },
  "voice": { "kokoro": "af_bella" }
}
```

- **Dancing** is triggered by asking her (the brain returns an `action`), by `/dance`, `/slow`, `/spin`, `/stop` in the chat box, or from the tray. Built-in styles: `groove` (upbeat, with phrases), `slow` (hip figure-eights, body waves, hands up into the hair), `spin`; they blend in and out over half a second. When `animations` are listed, dance requests play those clips instead (a "slow" request prefers clips whose name contains slow, rumba, waltz or belly).
- **Real dances (VRM)**: go to [mixamo.com](https://www.mixamo.com) (free Adobe account), search "dancing", download any clip as FBX ("Without Skin" is smallest), put it in a `dances/` folder next to the model and list it: `"animations": [{ "name": "salsa", "file": "/models/<id>/dances/Salsa_Dancing.fbx" }]`. The app retargets Mixamo's skeleton onto the VRM humanoid at load. `.vrma` files (Booth, VRoid Hub) play directly. Keep clip lists in `local.json` if you don't want them in git (Mixamo's terms allow use in your projects, not redistribution of the raw files).
- **Real dances (MMD)**: `.vmd` motions from their creators' pages; list them the same way. Most forbid redistribution.
- **`local.json`**: a gitignored file next to `character.json` whose keys override it, for private things: `animations`, `voice`, `model`, `outfits`.
- **Outfits**: `model` swaps the whole file; `hide`/`show` toggle meshes (VRM) or materials (MMD) by name fragment; `tint` recolours materials whose name contains the key (works on light textures). Ask her to change, type `/outfit`, or use the tray.
- **Morphs (MMD)**: `"morphs": { "happy": "笑い+mouthSmileLeft+mouthSmileRight", "mouth": "あ", "blink": "まばたき" }`; join several with `+`.
- **Framing**: `camera.fov` and `camera.yOffset` (fraction of body height) if she sits too high or low; `idle.armsDown` if her arms hang wrong (VRM rigs start in a T-pose, MMD rigs in an A-pose).

Bundled 3D characters: Victoria (bundled file) and Vita, Vivi, Shino (fetched from github.com/madjin/vrm-samples on first use). All four are VRoid Project sample models whose metadata states CC0 (see `src/renderer/public/models/victoria/LICENSE.txt`).

## VTube Studio models

Most purchased or commissioned VTuber models arrive as a VTube Studio folder (`*.vtube.json`, `*.model3.json` with no expressions listed, `*.exp3.json` files next to it, and an 8192 px texture folder). To use one:

1. Copy the folder under `src/renderer/public/models/<id>/` (or your user-data `character/<id>/model/`).
2. Rename files to plain ASCII if they contain spaces or non-Latin characters.
3. Edit the `.model3.json`: add `FileReferences.Expressions` as `[{"Name": "blush", "File": "expressions/blush.exp3.json"}, …]`, add `"Motions": {"Idle": []}`, and set `Groups` to `LipSync: ["ParamMouthOpenY"]` and `EyeBlink: ["ParamEyeLOpen", "ParamEyeROpen"]`.
4. Optionally downscale 8192 px textures to 4096 (`sips -Z 4096 texture_00.png` on macOS) for faster loading.
5. Map the emotions in `character.json` to the expression names you chose.

Check the model's licence before you share it. Models you bought are usually for your own use only, which is why this repository ships none.

## persona.md

Plain English, second person, as long as you like. What works:

- Who she is (age, temperament, what she likes, running jokes).
- How she talks (sentence length, pet names, what she never says).
- What she reacts to on screen, and what she leaves alone.
- How she helps when asked.
- A clear line on how far flirting goes. The default persona keeps it light; the file is yours.

Small local models follow persona text very literally. If she fixates on one topic, it is because the persona names it; make that line conditional ("only when you can see X").

Her memory is per character: `memory-<id>.json` in the user-data folder. Type `/forget` in the chat box to wipe the active character's memory.
