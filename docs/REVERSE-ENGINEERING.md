# Reverse-engineering Kyndred (the app in the reel) → building our own

Source reel: https://www.instagram.com/reels/DYmHYvhIRgt/ by **lilavtube** ("AI with an attitude hates testing his code. Gotta watch those project files…", tags `#kyndred`).

What the reel shows: an anime-style Live2D character pinned over a macOS desktop, on top of the Claude Code desktop app (visible: "Create PR", "4.6 · Max"). She reacts to what the developer is doing on screen (skipping tests, "just restart", "I am not a physics test dummy", "your animation… jiggling"), with a sassy personality, voice, and live facial expressions.

The product is **Kyndred** (getkyndred.com), a Romanian startup; the character is **Lila** (lilavtube = "Lila VTube"). Other characters: Maya, Rin, Ana.

---

## 1. Evidence ledger

Every claim below is tagged **Observed** (seen in a shipped artifact or a controlled capture), **Inferred** (strong but indirect), or **Unknown**.

### Rendering stack — Observed
Kyndred's own licenses page (`/licenses`) lists exactly what ships on "web, desktop and mobile":

| Component | License | Role |
|---|---|---|
| Live2D Cubism Core (`live2dcubismcore.min.js`) | Live2D proprietary (redistributable unmodified) | runtime for `.moc3` models |
| Live2D Cubism Web Framework | Live2D Open Software License | model loading, parameters, physics, expressions |
| `pixi-live2d-display-lipsyncpatch` (RaSan147 fork of guansss/pixi-live2d-display) | MIT | PixiJS plugin; the fork adds **audio-volume lip sync** (`model.speak(url)`) |
| PixiJS + `@pixi/filter-glow`, `@pixi/filter-advanced-bloom`, `@pixi/filter-kawase-blur`, `@pixi/filter-drop-shadow` | MIT | 2D WebGL renderer + the glow/bloom look |

Corroboration (Observed, REA capture `ev_0780cc52…`): every page, including `/login`, loads `/character/live2dcubismcore.min.js`, and an inline script titled `kyndred-console-noise-filter` suppresses `PixiJS Deprecation` and `[CSM][V/D/I]` (Cubism framework) console logs. The licenses page says Cubism Core ships "on web, desktop and mobile", so the desktop overlay is the **same web canvas in a native shell**, not a separate native renderer.

### Web app shell — Observed
- Next.js (App Router, Turbopack chunks) deployed on Vercel (`?dpl=` deployment ids, `/_vercel/insights`).
- Analytics: PostHog proxied through `/ingest/*`, Vercel Analytics, Meta Pixel; Sentry strings present.
- Sign-in is passwordless **email one-time-code**: `POST /auth/otp` `{email}` then `POST /auth/verify` `{email, code, next}` (same-origin route handlers; from chunk `0fb9hsnrbt47g.js`).
- The app itself lives at `/app` behind that login. Live Live2D models are only served to signed-in users (model policy page: "visitors see still portraits"), so the character runtime was not fetched in the unauthenticated capture.

### Auth backend — Inferred
The login chunk's error matcher looks for `otp_expired`, `security purposes`, `signups not allowed`, `request this after` — these are verbatim Supabase Auth (GoTrue) error messages. Very likely Supabase Auth behind the Next.js route handlers.

### Voice — Inferred
- Backed by the ElevenLabs Grants program (logo on every page); the dev-platform page shows `voice: 'elevenlabs:aria'`. Marketing claims "under 300ms" voice response and "emotion-aware voice".
- Lip sync is driven from the TTS audio (the lipsync fork maps mouth-open to audio volume).

### Screen awareness — Observed (marketing) / Unknown (mechanism)
- Updates page, July 2026: "Maya sees your game and reacts aloud in real time, 0.2-second reactions, fully in the cloud"; August 2026: "send photos in chat and turn on your camera during calls"; Windows app fix "no longer lowers your game's volume".
- Press: "on PC the character can run over other applications" (always-on-top overlay).
- **Unknown**: capture cadence, whether frames go to a vision LLM or a cheaper classifier, which LLM. Nothing in the public bundle references screen capture.

### Memory — Observed (their blog) 
"How AI memory actually works": short-term = recent chat + context buffer; long-term = **vector DB with retrieval weighted for relationship signals** (emotional peaks, inside jokes, milestones, unresolved threads); **scheduled daily/weekly summarization tuned to preserve emotional context**; graded forgetting ("some things stick forever, some fade in weeks, small talk vanishes").

### Animation driving — Observed (their blog + licenses)
"AI VTuber" post describes the pipeline they say they apply: LLM output carries **emotion tags** (happy/surprised/annoyed/sad) that are stripped from the text and used to trigger Live2D expression/motion states; lip sync from audio; comfort latency threshold ≈300 ms.

### Desktop shell — Unknown
Electron vs Tauri vs a WebView wrapper is not evidenced by any public artifact. (The `dist/Electron` text visible in the reel is in the developer's own terminal, not Kyndred's.) Open Windows alpha since July 2026; a macOS build is shown running in the reel.

### Not examined
- The Android APK (`com.getkyndred.app`) would reveal the mobile architecture, but it is only obtainable from Google Play or third-party mirrors; I did not download it.
- The authenticated `/app` bundle. I did not create an account. If you have one, a logged-in REA capture of `/app` would reveal the voice transport (WebSocket vs WebRTC), the model file layout, and the API surface.

---

## 2. Architecture we reconstruct

```
┌──────────────── Electron main ────────────────┐
│ transparent, frameless, always-on-top window   │
│ click-through except over the character        │
│ desktopCapturer → downscaled JPEG every N s     │
│ chokidar watch on a project dir (file events)   │
│ Gemini (vision + text) → {say, emotion, speak}  │
│ TTS: ElevenLabs if key, else macOS `say`        │
│ tiered memory (facts w/ importance + decay)     │
└───────────────┬────────── IPC ─────────────────┘
                │
┌───────────────▼──────── renderer ─────────────┐
│ PixiJS 7 + pixi-live2d-display-lipsyncpatch     │
│ Cubism Core from Live2D CDN                     │
│ expression/motion from emotion tag              │
│ model.speak(audio) → volume lip sync            │
│ speech bubble + text input                      │
└────────────────────────────────────────────────┘
```

Design choices that are ours, not Kyndred's: Gemini via Google AI Studio as the LLM (they don't say which they use; users bring their own key), local JSON memory instead of a vector DB, ElevenLabs with macOS `say` as the free fallback, a file watcher for "watching project files", tap and drag reactions.

See `deskmate/README.md` for how to run it.
