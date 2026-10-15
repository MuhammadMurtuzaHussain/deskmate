import type { Memory } from './memory'
import type { Settings } from './settings'
import { geminiGenerate, geminiCheckKey, GeminiBlockedError, GeminiQuotaError, type GeminiContent } from './gemini'
import { ollamaChat, ollamaModels, type OllamaMessage } from './ollama'
import { AVATAR_COMMANDS, EMOTIONS, type AvatarCommand, type BrainMode, type Emotion, type Reply, type Touch } from '../shared/types'

export interface Stimulus {
  kind: 'chat' | 'observe' | 'touch'
  text?: string
  screenshot?: { data: string; mediaType: 'image/jpeg' | 'image/png' }
  fileEvents?: string[]
  touch?: Touch
  /** observe only: true when the user pressed "look" themselves (she must answer), false for the periodic watch */
  manual?: boolean
  /** chat only: they asked about the screen but no capture was possible */
  blind?: boolean
}

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
// Free-tier quotas are per model, so a lighter sibling keeps her talking when the main one is spent.
const DEFAULT_FALLBACK_MODEL = 'gemini-flash-lite-latest'
const QUOTA_COOLDOWN_MS = 5 * 60_000
const DEFAULT_OLLAMA_MODEL = 'qwen3-vl:4b-instruct'

const OUTPUT_CONTRACT = `
Reply with ONE JSON object and nothing else, no code fences:
{"say": string, "emotion": "neutral"|"happy"|"flirty"|"surprised"|"annoyed"|"angry"|"sad"|"smug"|"shy", "speak": boolean, "remember": [{"text": string, "importance": 1|2|3|4|5}], "action": "dance"|"dance_slow"|"spin"|"stop_dancing"|"next_outfit"|null}

- "say": what you say out loud. Empty string if "speak" is false.
- "emotion": the face you make. "flirty" when you are teasing or being sweet on them, "smug" when you are right, "shy" when they get to you.
- "speak": for an observation, true only if you genuinely have something to say. For a direct message or a touch, always true.
- "remember": zero to three things worth keeping about the user, their project, or your relationship. importance: 1 small talk, 3 useful detail, 5 defining fact. Usually an empty array.
- Say only what you can actually see or were told. Never invent names, people, messages, files or events. If you are not sure what is on the screen, say what it looks like or ask; do not guess specifics.
- Never repeat a phrase. One thought per line.
- "action": null unless they explicitly ask you to move. "dance" when they ask for a dance; "dance_slow" when they ask for something slow, sensual or seductive; "spin" when they ask for a twirl; "stop_dancing" when they ask you to stop; "next_outfit" when they ask you to change clothes. Never dance just because they are tired, bored or asked a question.
`.trim()

/** Ollama structured-output schema for the reply (mirrors OUTPUT_CONTRACT). */
const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string' },
    emotion: { type: 'string', enum: [...EMOTIONS] },
    speak: { type: 'boolean' },
    remember: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, importance: { type: 'integer' } }, required: ['text', 'importance'] } },
    action: { type: ['string', 'null'], enum: [...AVATAR_COMMANDS, null] }
  },
  required: ['say', 'emotion', 'speak', 'remember', 'action']
}

const LOCAL_EXAMPLE = `Example of a good reply when they say "hey, long day": {"say": "you look like it. come here, tell me the worst part.", "emotion": "flirty", "speak": true, "remember": [], "action": null}`

const TOUCH_PROMPTS: Record<Touch['area'], string> = {
  head: 'They just poked you on the head.',
  chest: 'They just poked your chest. React in character: flustered, teasing or scolding, your call. Suggestive at most, never explicit.',
  body: 'They just poked your tummy.',
  legs: 'They just poked your leg.'
}

/**
 * The brain: Google AI Studio (Gemini) or a local model through Ollama.
 * DESKMATE_BRAIN=ollama makes Ollama primary; otherwise Gemini is primary when a key exists and Ollama,
 * when it is running with the configured model, takes over while Gemini is out of quota. Mirrors the pipeline Kyndred's own writing describes: the LLM returns
 * an emotion tag alongside the text; the tag drives the Live2D expression, the text drives TTS and lip sync.
 * The key comes from GEMINI_API_KEY / GOOGLE_API_KEY, or from what the user pasted into the app (settings).
 */
export class Brain {
  private key: string | null = null
  readonly ollamaModel = process.env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL
  private ollamaReady = false
  private readonly preferOllama = process.env.DESKMATE_BRAIN?.trim().toLowerCase() === 'ollama'
  readonly model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL
  readonly fallbackModel = process.env.GEMINI_FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK_MODEL
  mode: BrainMode = 'demo'
  /** When both models are out of quota, no API calls until this time; cheap canned reactions meanwhile. */
  private quotaUntil = 0

  constructor(
    private memory: Memory,
    private persona: string,
    private readonly settings: Settings
  ) {
    const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || settings.get().geminiApiKey || '').trim()
    if (key) {
      this.key = key
      this.mode = 'gemini'
    }
  }

  /** Looks for a running Ollama with the configured model. Call once at startup; cheap to call again. */
  async detectOllama(): Promise<{ running: boolean; hasModel: boolean; models: string[] }> {
    const models = await ollamaModels()
    const running = models !== null
    const hasModel = Boolean(models?.some((m) => m === this.ollamaModel || m.split(':')[0] === this.ollamaModel.split(':')[0]))
    this.ollamaReady = running && hasModel
    if (this.ollamaReady && (this.preferOllama || !this.key)) this.mode = 'ollama'
    return { running, hasModel, models: models ?? [] }
  }

  /** Character switch: a different person, a different memory. */
  setCharacter(memory: Memory, persona: string): void {
    this.memory = memory
    this.persona = persona
  }

  get modelName(): string {
    return this.mode === 'gemini' ? this.model : this.mode === 'ollama' ? `${this.ollamaModel} (local)` : 'demo'
  }

  private useOllamaNow(): boolean {
    if (!this.ollamaReady) return false
    if (this.mode === 'ollama') return true
    return this.cooldownSeconds() > 0 // Gemini out of quota: the local model covers
  }

  /** Seconds left in the quota cooldown, 0 when calls are allowed. */
  cooldownSeconds(): number {
    return Math.max(0, Math.ceil((this.quotaUntil - Date.now()) / 1000))
  }

  /** Called when the user pastes a key in the app. Verifies it against the API before saving. */
  async setKey(rawKey: string): Promise<{ ok: boolean; error?: string }> {
    const key = rawKey.trim()
    if (!key) return { ok: false, error: 'empty key' }
    const check = await geminiCheckKey(key)
    if (!check.ok) return check
    this.settings.set({ geminiApiKey: key })
    this.key = key
    this.mode = 'gemini'
    return { ok: true }
  }

  async respond(stimulus: Stimulus): Promise<Reply> {
    if (this.useOllamaNow()) return this.respondLocal(stimulus)
    if (!this.key) return this.canned(stimulus)
    if (this.cooldownSeconds() > 0) {
      // Out of quota: stay in character on taps, stay quiet on looks, be honest in chat.
      if (stimulus.kind === 'touch') return this.canned(stimulus)
      if (stimulus.kind === 'observe') return { say: '', emotion: 'neutral', speak: false, remember: [] }
      return {
        say: `Google cut me off for about ${Math.ceil(this.cooldownSeconds() / 60)} more minutes. Free-tier quota. Talk to me after.`,
        emotion: 'annoyed',
        speak: true,
        remember: []
      }
    }

    const facts = this.memory.recall()
    const memoryBlock = facts.length
      ? `What you remember about this person (importance in brackets):\n${facts.map((f) => `- [${f.importance}] ${f.text}`).join('\n')}`
      : 'You do not know this person yet.'

    const contents: GeminiContent[] = this.memory
      .recentTurns()
      .map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] }))
    const parts: GeminiContent['parts'] = []
    if (stimulus.screenshot) {
      parts.push({ inline_data: { mime_type: stimulus.screenshot.mediaType, data: stimulus.screenshot.data } })
    }
    parts.push({ text: this.promptText(stimulus) })
    contents.push({ role: 'user', parts })

    const system = `${this.persona}\n\n${OUTPUT_CONTRACT}\n\n${memoryBlock}`
    let text: string
    try {
      try {
        text = await geminiGenerate({ apiKey: this.key, model: this.model, system, contents })
      } catch (err) {
        if (!(err instanceof GeminiQuotaError) || this.fallbackModel === this.model) throw err
        console.warn(`[brain] ${err.message}; trying ${this.fallbackModel}`)
        text = await geminiGenerate({ apiKey: this.key, model: this.fallbackModel, system, contents })
      }
    } catch (err) {
      if (err instanceof GeminiQuotaError) {
        this.quotaUntil = Date.now() + QUOTA_COOLDOWN_MS
        console.warn(`[brain] both Gemini models out of quota; ${this.ollamaReady ? 'switching to the local model' : 'pausing API calls'} for 5 minutes`)
        return this.respond(stimulus) // takes the local or cooldown branch above
      }
      return this.failure(err, stimulus)
    }

    const reply = parseReply(text, stimulus.kind === 'observe' && !stimulus.manual ? 'observe' : 'chat')
    if (stimulus.kind === 'chat') this.memory.addTurn('user', stimulus.text ?? '')
    if (reply.speak && reply.say) this.memory.addTurn('assistant', reply.say)
    if (reply.remember.length) this.memory.remember(reply.remember)
    return reply
  }

  private async respondLocal(stimulus: Stimulus): Promise<Reply> {
    const facts = this.memory.recall()
    const memoryBlock = facts.length
      ? `What you remember about this person (importance in brackets):\n${facts.map((f) => `- [${f.importance}] ${f.text}`).join('\n')}`
      : 'You do not know this person yet.'
    const messages: OllamaMessage[] = [
      // Persona first, memory next, the output contract last so a small model has it freshest; one example anchors the shape.
      { role: 'system', content: `${this.persona}\n\n${memoryBlock}\n\n${OUTPUT_CONTRACT}\n\n${LOCAL_EXAMPLE}` },
      // Fewer turns for local models: their own earlier lines are the fastest way to a loop.
      ...this.memory.recentTurns(6).map((t): OllamaMessage => ({ role: t.role, content: t.text }))
    ]
    const current: OllamaMessage = { role: 'user', content: this.promptText(stimulus) }
    if (stimulus.screenshot) current.images = [stimulus.screenshot.data]
    messages.push(current)
    let text: string
    const started = Date.now()
    try {
      text = await ollamaChat({ model: this.ollamaModel, messages, schema: REPLY_SCHEMA })
      console.log(`[brain:ollama] ${this.ollamaModel} answered in ${Date.now() - started} ms`)
    } catch (err) {
      console.error('[brain:ollama]', err)
      const speak = stimulus.kind !== 'observe'
      const message = err instanceof Error ? err.message : String(err)
      if (/does not support images|image input/i.test(message)) {
        return { say: `My local model (${this.ollamaModel}) cannot see pictures. Pull a vision model.`, emotion: 'sad', speak, remember: [] }
      }
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { say: 'My local brain is still warming up. Ask me again.', emotion: 'annoyed', speak, remember: [] }
      }
      return { say: 'My local brain hiccuped. Is Ollama still running?', emotion: 'sad', speak, remember: [] }
    }
    const reply = parseReply(text, stimulus.kind === 'observe' && !stimulus.manual ? 'observe' : 'chat')
    // Small local models ramble; keep spoken lines to a few sentences unless they were asked for help.
    const helpAsked = stimulus.kind === 'chat' && /\b(help|fix|error|explain|how do|how to|what is|summar|draft|write)\b/i.test(stimulus.text ?? '')
    reply.say = trimSpoken(reply.say, helpAsked ? 8 : 3)
    if (stimulus.kind === 'chat') this.memory.addTurn('user', stimulus.text ?? '')
    if (reply.speak && reply.say) this.memory.addTurn('assistant', reply.say)
    if (reply.remember.length) this.memory.remember(reply.remember)
    return reply
  }

  private promptText(stimulus: Stimulus): string {
    if (stimulus.kind === 'chat') {
      if (stimulus.screenshot) {
        return `${stimulus.text ?? ''}\n\n[A screenshot of their screen is attached for context. Use it if the message is about what is on screen; otherwise answer the message and don't describe the screen.]`
      }
      if (stimulus.blind) {
        return `${stimulus.text ?? ''}\n\n[You cannot see their screen right now: screen capture is not permitted on this computer. Say that plainly in your own voice and ask them to allow Screen Recording for the app; do not guess what is on the screen.]`
      }
      return stimulus.text ?? ''
    }
    if (stimulus.kind === 'touch') {
      const t = stimulus.touch ?? { kind: 'tap', area: 'body' }
      const what =
        t.kind === 'drag'
          ? 'They grabbed you, dragged you around the screen for a moment, and put you down somewhere else.'
          : TOUCH_PROMPTS[t.area]
      return `[${what}] React out loud in one short line.`
    }
    const events = stimulus.fileEvents?.length
      ? `Project file changes since you last looked:\n${stimulus.fileEvents.join('\n')}`
      : 'No project file changes since you last looked.'
    const seen = stimulus.screenshot ? ' (screenshot attached)' : ' (no screenshot available: you cannot see the screen right now, say so if it matters)'
    if (stimulus.manual) {
      return `[They just asked you to look at their screen${seen}.]\n${events}\nYou must say something: react to what they are doing, tease, notice a detail, or ask about it. One or two sentences. "speak" is true.`
    }
    return `[You glance at the screen on your own${seen}.]\n${events}\nSay something if anything catches your eye, or if it has been a while since you spoke; you do not need a big reason. Stay quiet only if the scene is boring and unchanged.`
  }

  private failure(err: unknown, stimulus: Stimulus): Reply {
    const speak = stimulus.kind !== 'observe'
    if (err instanceof GeminiBlockedError) {
      return { say: "Mm, I'm not touching that one.", emotion: 'smug', speak, remember: [] }
    }
    console.error('[brain]', err)
    const message = err instanceof Error ? err.message : String(err)
    if (/HTTP (400|401|403)/.test(message)) {
      return { say: 'That Gemini key is not working. Check it in the panel.', emotion: 'sad', speak, remember: [] }
    }
    if (/HTTP 404/.test(message)) {
      return { say: `Google does not know the model "${this.model}". Change GEMINI_MODEL.`, emotion: 'sad', speak, remember: [] }
    }
    if (/HTTP 429/.test(message)) {
      return { say: 'Give me a second, I am being rate limited.', emotion: 'annoyed', speak, remember: [] }
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { say: 'Google is taking forever. Ask me again.', emotion: 'annoyed', speak, remember: [] }
    }
    if (/fetch failed|ENOTFOUND|ECONN/.test(message)) {
      return { say: 'No internet. Try again.', emotion: 'sad', speak, remember: [] }
    }
    return { say: 'Something broke on my side. Try again in a moment.', emotion: 'sad', speak, remember: [] }
  }

  /** Demo mode: no key yet. Keeps the app usable so you can see the overlay, lip sync and expressions. */
  private canned(stimulus: Stimulus): Reply {
    if (stimulus.kind === 'observe') {
      const lines: [string, Emotion][] = [
        ['Did you run the tests, or are we feeling lucky today?', 'smug'],
        ['Restarting it is not the same as fixing it, cutie.', 'annoyed'],
        ['That tab has been open for an hour. Close it or read it.', 'neutral']
      ]
      if (Math.random() < 0.5) return { say: '', emotion: 'neutral', speak: false, remember: [] }
      const [say, emotion] = lines[Math.floor(Math.random() * lines.length)]
      return { say, emotion, speak: true, remember: [] }
    }
    if (stimulus.kind === 'touch') {
      const lines: [string, Emotion][] =
        stimulus.touch?.kind === 'drag'
          ? [['Put me down! Or at least pick a nicer corner.', 'surprised'], ['Carrying me around now? Bold.', 'flirty']]
          : [['Hands to yourself, hotshot.', 'smug'], ['Hey. That tickles.', 'shy'], ['Again? You are needy today.', 'flirty']]
      const [say, emotion] = lines[Math.floor(Math.random() * lines.length)]
      return { say, emotion, speak: true, remember: [] }
    }
    return {
      say: 'I do not have a brain yet. Paste a Gemini API key in the panel and I will actually think about that.',
      emotion: 'annoyed',
      speak: true,
      remember: []
    }
  }
}

/** Keeps at most `maxSentences` sentences and drops a dangling fragment at the end. */
function trimSpoken(say: string, maxSentences: number): string {
  const parts = say.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [say]
  const complete = parts.filter((p) => /[.!?…]["')\]]*\s*$/.test(p))
  const kept = (complete.length ? complete : parts).slice(0, maxSentences)
  return kept.join('').trim()
}

/** Pulls a string field out of JSON that a small model cut off mid-way, so a truncated reply is still usable. */
function salvageField(text: string, field: string): string | undefined {
  const m = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text)
  if (!m) return undefined
  try {
    return JSON.parse(`"${m[1]}"`)
  } catch {
    return m[1]
  }
}

function parseReply(text: string, kind: Stimulus['kind']): Reply {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    let obj: Partial<Reply>
    try {
      obj = JSON.parse(cleaned) as Partial<Reply>
    } catch {
      // Truncated or slightly malformed JSON: keep what we can rather than reading the braces out loud.
      const say = salvageField(cleaned, 'say')
      if (say === undefined) throw new Error('unparseable')
      const emotion = salvageField(cleaned, 'emotion')
      const action = salvageField(cleaned, 'action')
      obj = { say: say.replace(/[,.;:\s]+$/, '').trim(), emotion: emotion as Emotion | undefined, speak: true, remember: [], action: action as AvatarCommand | undefined }
      console.warn('[brain] salvaged a truncated reply')
    }
    const emotion = (EMOTIONS as string[]).includes(obj.emotion ?? '') ? (obj.emotion as Emotion) : 'neutral'
    const remember = Array.isArray(obj.remember)
      ? obj.remember
          .filter((r) => r && typeof r.text === 'string')
          .map((r) => ({ text: r.text, importance: Math.min(5, Math.max(1, Number(r.importance) || 3)) }))
      : []
    const action = (AVATAR_COMMANDS as string[]).includes(String(obj.action ?? '')) ? (obj.action as AvatarCommand) : undefined
    return { say: String(obj.say ?? ''), emotion, speak: kind === 'observe' ? Boolean(obj.speak) : true, remember, action }
  } catch {
    // The model answered in prose; treat the whole thing as speech.
    return { say: cleaned, emotion: 'neutral', speak: true, remember: [] }
  }
}
