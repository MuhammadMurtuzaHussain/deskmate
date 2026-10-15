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
