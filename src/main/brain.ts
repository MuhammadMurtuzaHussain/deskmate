import type { Memory } from './memory'
import type { Settings } from './settings'
import { geminiGenerate, geminiCheckKey, GeminiBlockedError, GeminiQuotaError, type GeminiContent } from './gemini'
import type Anthropic from '@anthropic-ai/sdk'
import { callClaude, claudeClient, CLAUDE_EFFORTS, ClaudeError, DEFAULT_CLAUDE_MODEL, listClaudeModels, replyText, type ClaudeEffort, type ClaudeModelInfo } from './anthropic'
import { ollamaChat, ollamaModels, type OllamaMessage } from './ollama'
import { AVATAR_COMMANDS, BRAIN_TOOLS, CLAUDE_ONLY_TOOLS, EMOTIONS, type AvatarCommand, type BrainMode, type Emotion, type Reply, type ToolCall, type ToolName, type Touch } from '../shared/types'

/** Something her hands want her to tell the user about: a Claude Code job or a browsing run. */
export interface TaskReport {
  kind?: 'claude' | 'browse'
  phase: 'confirm' | 'started' | 'done' | 'failed' | 'cancelled' | 'status'
  title: string
  folder?: string
  /** Claude's final message, what she found online, the error, or the status list */
  detail?: string
}

export interface Stimulus {
  kind: 'chat' | 'observe' | 'touch' | 'task'
  text?: string
  screenshot?: { data: string; mediaType: 'image/jpeg' | 'image/png' }
  fileEvents?: string[]
  touch?: Touch
  /** observe only: true when the user pressed "look" themselves (she must answer), false for the periodic watch */
  manual?: boolean
  /** chat only: they asked about the screen but no capture was possible */
  blind?: boolean
  /** chat only: it came in through the microphone */
  voice?: boolean
  /** chat only: the web page open in Chrome, when the question is about it */
  page?: { url: string; title: string; text: string }
  task?: TaskReport
}

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
// Free-tier quotas are per model, so a lighter sibling keeps her talking when the main one is spent.
const DEFAULT_FALLBACK_MODEL = 'gemini-flash-lite-latest'
const QUOTA_COOLDOWN_MS = 5 * 60_000
const DEFAULT_OLLAMA_MODEL = 'qwen3-vl:4b-instruct'

const OUTPUT_CONTRACT = `
Reply with ONE JSON object and nothing else, no code fences:
{"say": string, "emotion": "neutral"|"happy"|"flirty"|"surprised"|"annoyed"|"angry"|"sad"|"smug"|"shy", "speak": boolean, "remember": [{"text": string, "importance": 1|2|3|4|5}], "action": "dance"|"dance_slow"|"spin"|"stop_dancing"|"next_outfit"|null, "tool": "claude"|"claude_resume"|"browse"|"page"|"open"|"app"|"tasks"|"cancel"|null, "tool_input": string, "tool_dir": string|null}

- "say": what you say out loud. Empty string if "speak" is false.
- "emotion": the face you make. "flirty" when you are teasing or being sweet on them, "smug" when you are right, "shy" when they get to you.
- "speak": for an observation, true only if you genuinely have something to say. For a direct message or a touch, always true.
- "remember": zero to three things worth keeping about the user, their project, or your relationship. importance: 1 small talk, 3 useful detail, 5 defining fact. Usually an empty array.
- Say only what you can actually see or were told. Never invent names, people, messages, files or events. If you are not sure what is on the screen, say what it looks like or ask; do not guess specifics.
- Never repeat a phrase. One thought per line.
- "action": null unless they explicitly ask you to move. "dance" when they ask for a dance; "dance_slow" when they ask for something slow, sensual or seductive; "spin" when they ask for a twirl; "stop_dancing" when they ask you to stop; "next_outfit" when they ask you to change clothes. Never dance just because they are tired, bored or asked a question.
- "tool": null unless they ask you to get something done on this computer. "claude" when they want real work done by Claude Code (the coding agent installed here): write or fix code, edit a video or vlog project, change files, run a job. "claude_resume" to continue an earlier Claude job or session. "browse" when they want something done or looked up in their Chrome browser: find information on the web, open a site and dig for something, fill in a form, get somewhere. "page" when they ask about the web page open in Chrome right now ("what's this article about", "summarize this tab", "is there a price on this page"). "open" to open an app, folder or website they name. "app" when they want something done inside a desktop app: send a message to someone on Discord or Slack, go to a chat or channel there, or type a prompt into the Claude desktop app ("ask the Claude app …"; a coding job is "claude"). "tasks" when they ask how Claude or a job is doing. "cancel" when they want the running job stopped. Talking, explaining, teasing and looking at the screen never need a tool; never reach for a tool because they sound busy or stressed, and never use "browse" for something you can answer yourself.
- "tool_input": for "claude", the instruction for Claude in plain words: exactly what they asked for, nothing added. For "claude_resume", what to tell Claude next ("" to just continue). For "browse", the goal in plain words. For "page", their question. For "open", the app name or URL. For "app", the app, who or where, and the exact words to send, as they said them ("Discord: tell sam I'm running late"). Otherwise "".
- "tool_dir": the project or folder they named ("the vlog", "deskmate", "my website"), else null.
- When "tool" is set, "say" is one short line that you are on it. Never claim the job is already done.
`.trim()

/** Ollama structured-output schema for the reply (mirrors OUTPUT_CONTRACT). */
const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string' },
    emotion: { type: 'string', enum: [...EMOTIONS] },
    speak: { type: 'boolean' },
    remember: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, importance: { type: 'integer' } }, required: ['text', 'importance'] } },
    action: { type: ['string', 'null'], enum: [...AVATAR_COMMANDS, null] },
    tool: { type: ['string', 'null'], enum: [...BRAIN_TOOLS, null] },
    tool_input: { type: 'string' },
    tool_dir: { type: ['string', 'null'] }
  },
  required: ['say', 'emotion', 'speak', 'remember', 'action', 'tool', 'tool_input', 'tool_dir']
}

/** With a Claude brain she has one more tool: a real agent run across the apps on this Mac. */
const CLAUDE_TOOLS_NOTE = `- With Claude as your brain you also have "tool": "computer": for anything they want done in an app on this Mac other than a Discord or Slack message or a Claude-app prompt. Texting someone in Messages / iMessage, WhatsApp or Telegram, writing in Notes, playing music in Spotify, working in Notion, Finder, Mail, Calendar: all "computer" ("text Notepad on iMessage that I'm running late", "open Spotify and play my liked songs"). "tool_input" is the goal in their words, with every detail they gave, including the exact words to send. "app" is only for Discord, Slack and the Claude desktop app; web lookups still use "browse"; code work still uses "claude".`

/** The reply contract as a strict schema for structured output: every field required, no extras, nulls spelled out. */
const CLAUDE_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    say: { type: 'string' },
    emotion: { type: 'string', enum: [...EMOTIONS] },
    speak: { type: 'boolean' },
    remember: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, importance: { type: 'integer', enum: [1, 2, 3, 4, 5] } },
        required: ['text', 'importance']
      }
    },
    action: { anyOf: [{ type: 'string', enum: [...AVATAR_COMMANDS] }, { type: 'null' }] },
    tool: { anyOf: [{ type: 'string', enum: [...BRAIN_TOOLS, ...CLAUDE_ONLY_TOOLS] }, { type: 'null' }] },
    tool_input: { type: 'string' },
    tool_dir: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  },
  required: ['say', 'emotion', 'speak', 'remember', 'action', 'tool', 'tool_input', 'tool_dir']
}

/** Planner schemas written for Ollama ("type": [..., "null"], no additionalProperties) made strict for Claude. */
export function strictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit)
    if (!node || typeof node !== 'object') return node
    const n: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) n[k] = visit(v)
    if (Array.isArray(n.type)) {
      const types = n.type as string[]
      const { type: _t, enum: en, ...rest } = n
      return {
        anyOf: types.map((t) => (t === 'null' ? { type: 'null' } : { ...rest, type: t, ...(en ? { enum: (en as unknown[]).filter((e) => e !== null) } : {}) }))
      }
    }
    if (n.type === 'object' && n.properties) {
      n.additionalProperties = false
      n.required = Object.keys(n.properties as object)
    }
    return n
  }
  return visit(schema) as Record<string, unknown>
}

const LOCAL_EXAMPLE = `Example of a good reply when they say "hey, long day": {"say": "you look like it. come here, tell me the worst part.", "emotion": "flirty", "speak": true, "remember": [], "action": null, "tool": null, "tool_input": "", "tool_dir": null}
Example when they say "get claude to add a dark mode to deskmate": {"say": "on it. claude's getting the dark mode job.", "emotion": "smug", "speak": true, "remember": [], "action": null, "tool": "claude", "tool_input": "Add a dark mode to the app.", "tool_dir": "deskmate"}
Example when they say "let ana know on slack the deploy is done": {"say": "telling ana.", "emotion": "neutral", "speak": true, "remember": [], "action": null, "tool": "app", "tool_input": "Slack: tell ana the deploy is done", "tool_dir": null}
Example when they say "find me a cheap flight to Lisbon next Friday": {"say": "give me a minute, I'm digging through Chrome.", "emotion": "neutral", "speak": true, "remember": [], "action": null, "tool": "browse", "tool_input": "Find a cheap flight to Lisbon next Friday and report the best option with price and times.", "tool_dir": null}`

/** What she says when she hears her name and nothing else (wake word). Short, so they can go straight on. */
export const ACKNOWLEDGEMENTS: [string, Emotion][] = [
  ['Yes?', 'happy'],
  ['Go on.', 'surprised'],
  ['Yeah?', 'neutral'],
  ['Here.', 'happy'],
  ['Listening.', 'neutral'],
  ["What's up?", 'flirty']
]

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
  ollamaModel: string
  private ollamaReady = false
  private preferOllama: boolean
  /** Claude (Anthropic API): key, chosen model, and a client made from the key */
  private claudeKey: string | null = null
  claudeModel: string
  /** how hard Claude thinks, for chat, planning and the agent alike (ANTHROPIC_EFFORT / setup window; default low) */
  claudeEffort: ClaudeEffort
  private claude: Anthropic | null = null
  private claudeModels: { at: number; list: ClaudeModelInfo[] } | null = null
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
    // .env wins; otherwise what was picked in the first-run window.
    const saved = settings.get()
    // What was picked in the setup window wins; .env is the starting point until something is picked there. (The other
    // way round, a DESKMATE_BRAIN=ollama line in .env quietly undid a Claude choice on every launch.)
    const envBrain = process.env.DESKMATE_BRAIN?.trim().toLowerCase()
    const brainPref = saved.brain ?? (envBrain === 'claude' ? 'anthropic' : envBrain)
    if (saved.brain && envBrain && envBrain !== saved.brain) console.log(`[brain] using ${saved.brain} as picked in Setup (DESKMATE_BRAIN=${envBrain} in .env is ignored)`)
    this.ollamaModel = saved.ollamaModel || process.env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL
    this.preferOllama = brainPref === 'ollama'
    this.claudeModel = saved.anthropicModel || process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_CLAUDE_MODEL
    this.claudeKey = (process.env.ANTHROPIC_API_KEY || saved.anthropicApiKey || '').trim() || null
    const effort = (saved.anthropicEffort || process.env.ANTHROPIC_EFFORT?.trim().toLowerCase() || 'low') as ClaudeEffort
    this.claudeEffort = CLAUDE_EFFORTS.includes(effort) ? effort : 'low'
    const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || saved.geminiApiKey || '').trim()
    if (key) {
      this.key = key
      this.mode = 'gemini'
    }
    if (this.claudeKey && brainPref === 'anthropic') {
      this.claude = claudeClient(this.claudeKey)
      this.mode = 'anthropic'
    }
  }

  /** Looks for a running Ollama with the configured model. Call once at startup; cheap to call again. */
  async detectOllama(): Promise<{ running: boolean; hasModel: boolean; models: string[] }> {
    const models = await ollamaModels()
    const running = models !== null
    const hasModel = Boolean(models?.some((m) => m === this.ollamaModel || m.split(':')[0] === this.ollamaModel.split(':')[0]))
    this.ollamaReady = running && hasModel
    if (this.ollamaReady && this.mode !== 'anthropic' && (this.preferOllama || !this.key)) this.mode = 'ollama'
    return { running, hasModel, models: models ?? [] }
  }

  /** First-run window: think with this local model from now on, and remember the choice. */
  async useOllama(model: string): Promise<{ ok: boolean; error?: string }> {
    const previous = this.ollamaModel
    this.ollamaModel = model.trim()
    const found = await this.detectOllama()
    if (!found.running || !found.hasModel) {
      this.ollamaModel = previous
      await this.detectOllama()
      return { ok: false, error: found.running ? `Ollama does not have ${model}: ollama pull ${model}` : 'Ollama is not running. Start the Ollama app, then try again.' }
    }
    this.preferOllama = true
    this.mode = 'ollama'
    this.claude = null
    this.settings.set({ brain: 'ollama', ollamaModel: this.ollamaModel })
    return { ok: true }
  }

  /** First-run window: think with Gemini (the key is checked first), and remember the choice. */
  async useGemini(key: string): Promise<{ ok: boolean; error?: string }> {
    const result = await this.setKey(key)
    if (!result.ok) return result
    this.preferOllama = false
    this.claude = null
    this.settings.set({ brain: 'gemini' })
    return result
  }

  /** Setup window: think with Claude. A new key is checked by listing its models; the model must be one of them. */
  async useClaude(key: string | null, model: string, effort?: ClaudeEffort): Promise<{ ok: boolean; error?: string; models?: ClaudeModelInfo[] }> {
    const useKey = key?.trim() || this.claudeKey
    if (!useKey) return { ok: false, error: 'Paste an Anthropic API key first (console.anthropic.com → API keys).' }
    let models: ClaudeModelInfo[]
    try {
      models = await listClaudeModels(useKey)
    } catch (err) {
      return { ok: false, error: err instanceof ClaudeError && err.code === 'auth' ? 'That key was not accepted.' : (err as Error).message }
    }
    this.claudeModels = { at: Date.now(), list: models }
    const pick = model?.trim() || this.claudeModel
    if (!models.some((m) => m.id === pick)) return { ok: false, error: `This key cannot use ${pick}.`, models }
    this.claudeKey = useKey
    this.claudeModel = pick
    if (effort && CLAUDE_EFFORTS.includes(effort)) this.claudeEffort = effort
    this.claude = claudeClient(useKey)
    this.mode = 'anthropic'
    this.settings.set({ brain: 'anthropic', anthropicApiKey: useKey, anthropicModel: pick, anthropicEffort: this.claudeEffort })
    return { ok: true, models }
  }

  /** The models the saved key can use (cached for ten minutes); empty without a key. */
  async claudeModelList(): Promise<{ models: ClaudeModelInfo[]; error?: string }> {
    if (!this.claudeKey) return { models: [] }
    if (this.claudeModels && Date.now() - this.claudeModels.at < 600_000) return { models: this.claudeModels.list }
    try {
      const list = await listClaudeModels(this.claudeKey)
      this.claudeModels = { at: Date.now(), list }
      return { models: list }
    } catch (err) {
      return { models: [], error: (err as Error).message }
    }
  }

  get hasClaudeKey(): boolean {
    return Boolean(this.claudeKey)
  }

  /** The client the computer agent uses, when her brain is Claude. */
  get claudeForAgent(): { client: Anthropic; model: string; effort: ClaudeEffort } | null {
    return this.mode === 'anthropic' && this.claude ? { client: this.claude, model: this.claudeModel, effort: this.claudeEffort } : null
  }

  get hasGeminiKey(): boolean {
    return Boolean(this.key)
  }

  /** Character switch: a different person, a different memory. */
  setCharacter(memory: Memory, persona: string): void {
    this.memory = memory
    this.persona = persona
  }

  get modelName(): string {
    if (this.mode === 'anthropic') return this.claudeModel
    return this.mode === 'gemini' ? this.model : this.mode === 'ollama' ? `${this.ollamaModel} (local)` : 'demo'
  }

  /** True when some model can think right now (for tools that need a planner). */
  get canThink(): boolean {
    if (this.mode === 'anthropic') return true
    return this.useOllamaNow() || (Boolean(this.key) && this.cooldownSeconds() === 0)
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

  /**
   * A bare planning call for her hands (the browse loop): no persona, one system prompt, one message, a JSON
   * schema; returns the parsed object. Uses whichever model is current, like everything else.
   */
  async plan(system: string, user: string, schema: Record<string, unknown>): Promise<Record<string, unknown>> {
    let text: string
    if (this.mode === 'anthropic' && this.claude) {
      const res = await callClaude(this.claude, {
        model: this.claudeModel,
        system: [{ type: 'text', text: system }],
        messages: [{ role: 'user', content: user }],
        schema: strictSchema(schema),
        effort: this.claudeEffort,
        maxTokens: 8000
      })
      text = replyText(res)
    } else if (this.useOllamaNow()) {
      text = await ollamaChat({
        model: this.ollamaModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        schema,
        numPredict: 600,
        temperature: 0.3
      })
    } else {
      if (!this.key) throw new Error('no brain yet: paste a Gemini key or start Ollama')
      if (this.cooldownSeconds() > 0) throw new Error('Gemini is out of quota for a few minutes')
      try {
        text = await geminiGenerate({ apiKey: this.key, model: this.model, system, contents: [{ role: 'user', parts: [{ text: user }] }] })
      } catch (err) {
        if (err instanceof GeminiQuotaError) {
          this.quotaUntil = Date.now() + QUOTA_COOLDOWN_MS
          if (this.ollamaReady) return this.plan(system, user, schema)
        }
        throw err
      }
    }
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try {
      return JSON.parse(cleaned) as Record<string, unknown>
    } catch {
      const m = /\{[\s\S]*\}/.exec(cleaned)
      if (m) {
        try {
          return JSON.parse(m[0]) as Record<string, unknown>
        } catch {
          // fall through
        }
      }
      throw new Error(`the planner returned no JSON: ${cleaned.slice(0, 120)}`)
    }
  }

  /** "Mika?" and nothing else: a one-word "yes?" from the canned set. No model, so it is back before they breathe in. */
  acknowledge(): Reply {
    const [say, emotion] = ACKNOWLEDGEMENTS[Math.floor(Math.random() * ACKNOWLEDGEMENTS.length)]
    return { say, emotion, speak: true, remember: [] }
  }

  async respond(stimulus: Stimulus): Promise<Reply> {
    if (stimulus.blind) {
      // No capture and they asked about the screen: never let a model guess; say so in her own words.
      const lines: [string, Emotion][] = [
        ["I can't see your screen right now. Give me Screen Recording in System Settings and restart me, then ask again.", 'annoyed'],
        ["My eyes are switched off: screen capture is blocked. Allow Screen Recording for me, restart, and I'll look.", 'sad']
      ]
      const [say, emotion] = lines[Math.floor(Math.random() * lines.length)]
      return { say, emotion, speak: true, remember: [] }
    }
    if (this.mode === 'anthropic' && this.claude) return this.respondClaude(stimulus)
    if (this.useOllamaNow()) return this.respondLocal(stimulus)
    if (!this.key) return this.canned(stimulus)
    if (this.cooldownSeconds() > 0) {
      // Out of quota: stay in character on taps and task reports, stay quiet on looks, be honest in chat.
      if (stimulus.kind === 'touch' || stimulus.kind === 'task') return this.canned(stimulus)
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

    const reply = parseReply(text, stimulus)
    if (!reply.say && (stimulus.kind === 'chat' || stimulus.kind === 'task')) {
      reply.say = this.canned(stimulus).say
      reply.speak = true
    }
    this.commit(stimulus, reply)
    return reply
  }

  /**
   * Claude: the persona and the output contract are the stable, cached part of the system prompt; memory follows,
   * then the recent turns. Structured output holds her to the reply contract. A rate limit or an outage hands this
   * reply to the local model when there is one.
   */
  private async respondClaude(stimulus: Stimulus): Promise<Reply> {
    const client = this.claude as Anthropic
    const facts = this.memory.recall()
    const memoryBlock = facts.length
      ? `What you remember about this person (importance in brackets):\n${facts.map((f) => `- [${f.importance}] ${f.text}`).join('\n')}`
      : 'You do not know this person yet.'
    const messages: Anthropic.Beta.BetaMessageParam[] = this.memory
      .recentTurns()
      .map((t): Anthropic.Beta.BetaMessageParam => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.text }))
    while (messages.length && messages[0].role !== 'user') messages.shift()
    const content: Anthropic.Beta.BetaContentBlockParam[] = []
    if (stimulus.screenshot) {
      content.push({ type: 'image', source: { type: 'base64', media_type: stimulus.screenshot.mediaType, data: stimulus.screenshot.data } })
    }
    content.push({ type: 'text', text: this.promptText(stimulus) })
    messages.push({ role: 'user', content })
    let text: string
    try {
      const res = await callClaude(client, {
        model: this.claudeModel,
        system: [
          { type: 'text', text: `${this.persona}\n\n${OUTPUT_CONTRACT}\n${CLAUDE_TOOLS_NOTE}`, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: memoryBlock }
        ],
        messages,
        schema: CLAUDE_REPLY_SCHEMA,
        effort: this.claudeEffort,
        maxTokens: 8000
      })
      text = replyText(res)
    } catch (err) {
      const claudeErr = err as ClaudeError
      console.warn(`[brain:claude] ${claudeErr.message}`)
      if ((claudeErr.code === 'rate' || claudeErr.code === 'overloaded' || claudeErr.code === 'network') && this.ollamaReady) return this.respondLocal(stimulus)
      if (stimulus.kind === 'touch' || stimulus.kind === 'task') return this.canned(stimulus)
      if (stimulus.kind === 'observe') return { say: '', emotion: 'neutral', speak: false, remember: [] }
      const say =
        claudeErr.code === 'auth'
          ? 'My Anthropic key stopped working. Fix it in Setup, from my menu.'
          : claudeErr.code === 'refusal'
            ? "Mm, I'm not touching that one."
            : claudeErr.code === 'bad_request'
              ? `Claude did not like that request: ${claudeErr.message.slice(0, 120)}`
              : `I can't reach Claude right now (${claudeErr.message}). Try me again in a minute.`
      return { say, emotion: 'sad', speak: true, remember: [] }
    }
    const reply = parseReply(text, stimulus, true)
    if (!reply.say && (stimulus.kind === 'chat' || stimulus.kind === 'task')) {
      reply.say = this.canned(stimulus).say
      reply.speak = true
    }
    this.commit(stimulus, reply)
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
    const direct = stimulus.kind === 'chat' || stimulus.kind === 'task'
    // Page questions carry the page text and deserve a fuller answer than a quip.
    const numPredict = stimulus.page || (stimulus.task && stimulus.task.phase === 'done') ? 480 : undefined
    try {
      text = await ollamaChat({ model: this.ollamaModel, messages, schema: REPLY_SCHEMA, numPredict })
      console.log(`[brain:ollama] ${this.ollamaModel} answered in ${Date.now() - started} ms`)
      if (direct && !salvageField(text, 'say')?.trim()) {
        // A direct message deserves an answer: one nudge before the fallback line.
        console.log('[brain:ollama] empty line for a direct message; asking once more')
        text = await ollamaChat({
          model: this.ollamaModel,
          messages: [...messages, { role: 'system', content: 'They spoke to you directly. Answer them now in one or two sentences; "say" must not be empty and "speak" must be true.' }],
          schema: REPLY_SCHEMA,
          numPredict
        })
      }
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
    const reply = parseReply(text, stimulus)
    if (!reply.say || !reply.speak) console.log(`[brain:ollama] quiet reply; raw: ${text.slice(0, 200)}`)
    if (direct && !reply.say) {
      // A direct message never ends in silence.
      reply.say = stimulus.kind === 'task' ? this.canned(stimulus).say : 'Say that again? I lost the thread for a second.'
      reply.speak = true
    }
    // Small local models ramble; keep spoken lines to a few sentences unless they were asked for help.
    const helpAsked = stimulus.kind === 'chat' && /\b(help|fix|error|explain|how do|how to|what is|summar|draft|write)\b/i.test(stimulus.text ?? '')
    reply.say = trimSpoken(reply.say, stimulus.kind === 'task' || stimulus.page ? 5 : helpAsked ? 8 : 3)
    this.commit(stimulus, reply)
    return reply
  }

  /** A small model sometimes announces a job as done the moment it starts, or forgets to ask. Those lines are replaced
   * with plain ones: on these two the facts matter more than the voice. */
  private guardTaskLine(stimulus: Stimulus, reply: Reply): void {
    // A line that comes with a tool is spoken before the tool runs: "just sent it" would be a lie (a local model said
    // exactly that before Discord was even open).
    if (stimulus.kind === 'chat' && reply.tool && /\b(?:sent|posted|messaged|delivered|typed|asked|told|opened|done|finished|handled)\b/i.test(reply.say)) {
      console.log(`[brain] replaced a line that claimed the ${reply.tool.name} tool already ran: ${reply.say.slice(0, 80)}`)
      reply.say = 'On it.'
      reply.speak = true
      return
    }
    if (stimulus.kind !== 'task' || !stimulus.task) return
    const phase = stimulus.task.phase
    const claimsDone = /\b(done|ready|finished|complete[d]?|created|made|fixed|all set|sorted|handled|delivered|found)\b/i.test(reply.say)
    if ((phase === 'started' && claimsDone) || (phase === 'confirm' && !/\?/.test(reply.say))) {
      console.log(`[brain] replaced an off-script ${phase} line: ${reply.say.slice(0, 80)}`)
      reply.say = this.canned(stimulus).say
      reply.speak = true
    }
  }

  /** Writes the exchange into her memory: the user's words, what her hands reported, her own line, new facts. */
  private commit(stimulus: Stimulus, reply: Reply): void {
    this.guardTaskLine(stimulus, reply)
    if (stimulus.kind === 'chat') this.memory.addTurn('user', stimulus.text ?? '')
    if (stimulus.kind === 'task' && stimulus.task && stimulus.task.phase !== 'confirm' && stimulus.task.phase !== 'status') {
      const t = stimulus.task
      const who = t.kind === 'browse' ? 'Browsing' : 'Claude Code job'
      const extra = t.phase === 'done' && t.detail ? `. ${t.kind === 'browse' ? 'Found' : "Claude's message"}: ${t.detail.slice(0, 300)}` : t.phase === 'failed' && t.detail ? `: ${t.detail.slice(0, 200)}` : ''
      this.memory.addTurn('user', `[${who} ${t.phase}: "${t.title}"${extra}]`)
    }
    if (reply.speak && reply.say) this.memory.addTurn('assistant', reply.say)
    if (reply.remember.length) this.memory.remember(reply.remember)
  }

  private promptText(stimulus: Stimulus): string {
    if (stimulus.kind === 'chat') {
      const spoken = stimulus.voice ? '\n\n[They said this out loud; it came through speech recognition, so a word may be off. Keep your answer short, it will be read aloud.]' : ''
      if (stimulus.page) {
        const p = stimulus.page
        return `${stimulus.text ?? ''}\n\n[The web page open in their Chrome is "${p.title}" (${p.url}). Its text, as far as it fits:\n${p.text}\n]\nAnswer from the page. If they want the gist, give it in two to four spoken sentences; keep names, numbers and prices exact; say so if the page does not hold the answer.${spoken}`
      }
      if (stimulus.screenshot) {
        return `${stimulus.text ?? ''}\n\n[A screenshot of their screen is attached for context. Use it if the message is about what is on screen; otherwise answer the message and don't describe the screen.]${spoken}`
      }
      if (stimulus.blind) {
        return `${stimulus.text ?? ''}\n\n[You cannot see their screen right now: screen capture is not permitted on this computer. Say that plainly in your own voice and ask them to allow Screen Recording for the app; do not guess what is on the screen.]`
      }
      return `${stimulus.text ?? ''}${spoken}`
    }
    if (stimulus.kind === 'task' && stimulus.task) {
      const t = stimulus.task
      const where = t.folder ? ` in the folder "${t.folder}"` : ''
      if (t.kind === 'browse') {
        switch (t.phase) {
          case 'started':
            return `[You just started browsing in their Chrome for: "${t.title}". One short line in your own voice that you are on it; no results yet.]`
          case 'done':
            return `[You finished browsing for them. Goal: "${t.title}". What you found, exact:\n${t.detail || '(nothing)'}\n]\nTell them in your own voice in two or three sentences. Keep every fact, name, number and price exactly as written; add nothing.`
          case 'failed':
            return `[You could not finish browsing for "${t.title}". Where it stopped: ${t.detail || 'unknown'}]\nTell them plainly in one or two sentences, in your voice, and what they can do.`
          default:
            return `[Browsing update for "${t.title}": ${t.detail ?? ''}] Relay it in one short line.`
        }
      }
      switch (t.phase) {
        case 'confirm':
          return `[They asked you to hand a job to Claude Code${where}: "${t.title}". Before it runs, check with them in one short line in your own voice: repeat the job in a few words and ask whether to send it. Do not start anything yourself and do not add to the job.]`
        case 'started':
          return `[You just handed a job to Claude Code (the coding agent on this computer)${where}: "${t.title}". Tell them in one short line, in your own voice, that it is running now. Do not claim it is finished and do not invent results.]`
        case 'done':
          return `[Claude Code finished the job "${t.title}"${where}. Its final message, word for word:\n${t.detail || '(no message)'}\n]\nTell them the outcome in your own voice in one to three sentences. Keep every fact exactly as written (file names, numbers, what changed) and add nothing the message does not say. If the message asks them something, pass the question on.`
        case 'failed':
          return `[Claude Code could not finish "${t.title}"${where}. What went wrong: ${t.detail || 'unknown'}]\nTell them plainly, in one or two sentences and in your voice, what happened and what they can do. Do not invent a cause.`
        case 'cancelled':
          return `[You stopped Claude's job "${t.title}" because they asked.] Confirm in one short line.`
        case 'status':
          return `[Status of Claude's jobs, exact:\n${t.detail || 'No jobs.'}\n]\nRelay this in your own voice in one to three sentences; keep names, states and times exact.`
      }
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

  /** Demo mode: no key yet. Keeps the app usable so you can see the overlay, lip sync and expressions. Also the
   * plain-words fallback for task reports when no model is available. */
  private canned(stimulus: Stimulus): Reply {
    if (stimulus.kind === 'task' && stimulus.task) {
      const t = stimulus.task
      const where = t.folder ? ` in ${t.folder}` : ''
      const line = (say: string, emotion: Emotion): Reply => ({ say, emotion, speak: true, remember: [] })
      if (t.kind === 'browse') {
        switch (t.phase) {
          case 'started':
            return line(`On it, I'm looking in Chrome: ${t.title}.`, 'neutral')
          case 'done':
            return line(`Here's what I found. ${(t.detail ?? '').slice(0, 400)}`.trim(), 'happy')
          case 'failed':
            return line(`I couldn't finish that in Chrome: ${t.detail ?? 'unknown problem'}`, 'sad')
          default:
            return line(t.detail || 'Still browsing.', 'neutral')
        }
      }
      switch (t.phase) {
        case 'confirm':
          return line(`Send this to Claude${where}: "${t.title}"? Yes or no.`, 'neutral')
        case 'started':
          return line(`Claude is on it${where}: ${t.title}. I'll tell you when it's done.`, 'smug')
        case 'done':
          return line(`Claude finished "${t.title}". ${(t.detail ?? '').slice(0, 300)}`.trim(), 'happy')
        case 'failed':
          return line(`Claude could not finish "${t.title}": ${t.detail ?? 'unknown error'}`, 'sad')
        case 'cancelled':
          return line(`Stopped. "${t.title}" is off.`, 'neutral')
        case 'status':
          return line(t.detail || 'No Claude jobs yet.', 'neutral')
      }
    }
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
    if (stimulus.page) {
      return { say: `The page is "${stimulus.page.title}". I need a brain (a Gemini key or Ollama) to read it for you.`, emotion: 'neutral', speak: true, remember: [] }
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

function parseReply(text: string, stimulus: Stimulus, claude = false): Reply {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const quietAllowed = stimulus.kind === 'observe' && !stimulus.manual
  try {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(cleaned) as Record<string, unknown>
    } catch {
      // Truncated or slightly malformed JSON: keep what we can rather than reading the braces out loud.
      const say = salvageField(cleaned, 'say')
      if (say === undefined) throw new Error('unparseable')
      obj = {
        say: say.replace(/[,.;:\s]+$/, '').trim(),
        emotion: salvageField(cleaned, 'emotion'),
        speak: true,
        remember: [],
        action: salvageField(cleaned, 'action'),
        tool: salvageField(cleaned, 'tool'),
        tool_input: salvageField(cleaned, 'tool_input'),
        tool_dir: salvageField(cleaned, 'tool_dir')
      }
      console.warn('[brain] salvaged a truncated reply')
    }
    const emotion = (EMOTIONS as string[]).includes(String(obj.emotion ?? '')) ? (obj.emotion as Emotion) : 'neutral'
    const remember = Array.isArray(obj.remember)
      ? (obj.remember as Array<{ text?: unknown; importance?: unknown }>)
          .filter((r) => r && typeof r.text === 'string')
          .map((r) => ({ text: r.text as string, importance: Math.min(5, Math.max(1, Number(r.importance) || 3)) }))
      : []
    const action = (AVATAR_COMMANDS as string[]).includes(String(obj.action ?? '')) ? (obj.action as AvatarCommand) : undefined
    let tool: ToolCall | undefined
    // Only a direct message can start a job; a glance at the screen, a poke or a page question never does.
    const allowed = claude ? [...BRAIN_TOOLS, ...CLAUDE_ONLY_TOOLS] : BRAIN_TOOLS
    if (stimulus.kind === 'chat' && !stimulus.page && (allowed as string[]).includes(String(obj.tool ?? ''))) {
      tool = {
        name: obj.tool as ToolName,
        input: String(obj.tool_input ?? '').trim(),
        dir: obj.tool_dir ? String(obj.tool_dir).trim() : null
      }
    }
    return { say: String(obj.say ?? ''), emotion, speak: quietAllowed ? Boolean(obj.speak) : true, remember, action, tool }
  } catch {
    // The model answered in prose; treat the whole thing as speech.
    return { say: cleaned, emotion: 'neutral', speak: true, remember: [] }
  }
}
