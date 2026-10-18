import type Anthropic from '@anthropic-ai/sdk'
import { callClaude, ClaudeError } from './anthropic'
import type { AppRequest, RoutineResult } from './apps'
import { Hands, HandsError, type Snapshot } from './hands'

/**
 * Her agent with a Claude brain: a goal in, Claude works the Mac through her hands (open an app, look at its window,
 * click a numbered element, type, press keys, pick a menu item, take a screenshot) and loops act, look, check until
 * it is done or stuck, then says what happened. The safety rules live in the tools, not in the prompt: keys only go to
 * the app it is working in, some apps are off limits, and anything that sends, posts, deletes or pays waits for the
 * user's yes.
 */

export interface ComputerDeps {
  client: Anthropic
  model: string
  effort: 'low' | 'medium' | 'high'
  hands: Hands
  /** reads the question out and waits for a yes */
  confirm(question: string): Promise<boolean>
  /** a downscaled capture of the screen with her own window greyed out */
  screenshot(): Promise<{ data: string; mediaType: 'image/jpeg' | 'image/png' } | undefined>
  /** the Discord / Slack / Claude app routines, with their own read-back */
  runApp(req: AppRequest): Promise<RoutineResult>
  openUrl(url: string): Promise<void>
  readWebPage(): Promise<string>
  onStep(text: string): void
  log(line: string): void
  stopped(): boolean
  /** her own app, so the agent never drives it */
  selfBundleIds: string[]
  maxSteps?: number
}

export interface ComputerResult {
  ok: boolean
  /** a sentence or two she says out loud */
  answer: string
  steps: number
}

/** Off limits whatever the goal: secrets, system settings, and shells (Claude Code jobs exist for real terminal work). */
const DENY_APPS = new Set([
  'com.apple.keychainaccess',
  'com.1password.1password',
  'com.agilebits.onepassword7',
  'com.bitwarden.desktop',
  'com.apple.systempreferences',
  'com.apple.SecurityAgent',
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'com.mitchellh.ghostty'
])
/** Where Return sends something to other people. */
const MESSAGING_APPS = new Set([
  'com.hnc.Discord',
  'com.tinyspeck.slackmacgap',
  'com.apple.MobileSMS',
  'net.whatsapp.WhatsApp',
  'desktop.WhatsApp',
  'ru.keepcoder.Telegram',
  'org.telegram.desktop',
  'com.apple.mail',
  'com.microsoft.Outlook',
  'com.microsoft.teams2',
  'org.whispersystems.signal-desktop'
])
const RISKY_LABEL = /\b(send|post|publish|tweet|reply|submit|delete|remove|trash|erase|buy|pay|purchase|checkout|check out|order|transfer|donate|subscribe|unsubscribe|confirm|sign out|log out|accept|agree|share|invite|call|leave)\b/i
const NEVER_TYPE = /\b(?:\d[ -]?){13,19}\b|password|passcode|cvv|cvc|social security|iban/i

const SYSTEM = `You operate the user's Mac for them through tools, one careful step at a time, the way a person at the keyboard would.

How to work:
- Start with look (or open_app, which looks for you). Element numbers come from the latest look and go stale once anything changes; look again after every action that changes the screen, and use what you see to check the action worked before moving on.
- Prefer the app's own keyboard shortcuts and search (⌘K quick switchers, ⌘F, ⌘L in browsers, ⌘N) over long chains of clicks. Use choose_menu when you know the menu item.
- To type into a field: type_text with its element number. To submit, press_keys "return" afterwards.
- For a message on Discord or Slack use send_message; for a question to the Claude desktop app use ask_claude_app. For web pages use open_url and read_web_page.
- If the screen does not have what you need in its text, take a screenshot.
- Never enter passwords, card numbers or personal data; never buy, pay, or delete anything the user did not ask for. When a step needs their decision or a detail you don't have, ask_user (yes/no questions only).
- If the same approach failed twice, try another way; if you are stuck, stop and say where.

Your final reply is spoken out loud by the user's desk companion: one to three short, plain sentences, saying what you did and what you found, with names and numbers exact. No markdown, no lists.`

type Input = Record<string, unknown>

function tool(name: string, description: string, properties: Record<string, unknown>): Anthropic.Beta.BetaTool {
  return {
    name,
    description,
    strict: true,
    input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
  }
}

const elementRef = { anyOf: [{ type: 'integer' }, { type: 'null' }] }

const TOOLS: Anthropic.Beta.BetaTool[] = [
  tool('open_app', 'Open an app by name (or bring it to the front if it is running) and look at its window.', { name: { type: 'string' } }),
  tool('look', 'Read the front window: its title, numbered elements you can act on, and its visible text.', {}),
  tool('screenshot', 'A picture of the screen, for when the text from look is not enough.', {}),
  tool('click', 'Press element n from the latest look (a button, link, row, tab, checkbox).', { element: { type: 'integer' } }),
  tool('type_text', 'Type text. With an element number the text goes into that field (it is focused first); with null it goes where the caret is.', {
    text: { type: 'string' },
    element: elementRef
  }),
  tool('press_keys', 'Press a key or shortcut, e.g. "return", "escape", "cmd+k", "cmd+shift+n", "down", "tab".', { combo: { type: 'string' } }),
  tool('choose_menu', 'Pick a menu-bar item of the front app by its titles, e.g. ["File", "New Window"] or just ["New Window"].', {
    path: { type: 'array', items: { type: 'string' } }
  }),
  tool('send_message', 'Send a message to a person or channel on Discord or Slack (it finds the chat, checks it, and asks the user before sending).', {
    app: { type: 'string', enum: ['discord', 'slack'] },
    to: { type: 'string' },
    text: { type: 'string' }
  }),
  tool('ask_claude_app', 'Type a prompt into a new chat in the Claude desktop app and send it.', { prompt: { type: 'string' } }),
  tool('open_url', 'Open a web address in the browser.', { url: { type: 'string' } }),
  tool('read_web_page', 'Read the text of the page open in the browser.', {}),
  tool('ask_user', 'Ask the user a yes/no question out loud and wait for the answer.', { question: { type: 'string' } })
]

function render(s: Snapshot): string {
  return [
    `App: ${s.app} (${s.bundleId})`,
    `Window: ${s.title ?? '(no title)'}`,
    `Elements:\n${s.elements.length ? s.elements.join('\n') : '(none readable; try a screenshot)'}`,
    s.text ? `Text:\n${s.text}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export async function runComputerTask(goal: string, deps: ComputerDeps): Promise<ComputerResult> {
  const { hands } = deps
  const maxSteps = deps.maxSteps ?? 25
  /** the app the agent is working in, from its last look; keys and clicks only go there */
  let target: string | null = null
  let last: Snapshot | null = null

  const blocked = (bundleId: string): string | null => {
    if (DENY_APPS.has(bundleId)) return `${bundleId} is off limits for you; tell the user to do this part themselves.`
    if (deps.selfBundleIds.includes(bundleId)) return 'That is the companion app itself; switch to the app you need first.'
    return null
  }
  const lookNow = async (bundleId?: string): Promise<string> => {
    last = await hands.snapshot(bundleId)
    target = last.bundleId || null
    deps.log(`look: ${last.app} · ${last.title} · ${last.elements.length} elements`)
    const no = target ? blocked(target) : null
    return no ? `${no}\n(Front app: ${last.app}.)` : render(last)
  }
  const elementLine = (n: number): string => last?.elements.find((l) => l.startsWith(`[${n}] `)) ?? ''
  const needTarget = (): string | null => (target ? blocked(target) : 'Look first, so you know which app you are in.')

  async function execute(name: string, input: Input): Promise<string | Anthropic.Beta.BetaToolResultBlockParam['content']> {
    switch (name) {
      case 'open_app': {
        const app = await hands.resolve(String(input.name))
        const no = blocked(app.bundleId)
        if (no) return no
        deps.onStep(`opening ${app.name}`)
        const opened = await hands.launch(app.bundleId)
        if (!opened.wasRunning) await new Promise((r) => setTimeout(r, 2500))
        return lookNow(app.bundleId)
      }
      case 'look':
        deps.onStep('looking')
        return lookNow()
      case 'screenshot': {
        deps.onStep('taking a screenshot')
        const shot = await deps.screenshot()
        if (!shot) return 'No screenshot: Screen Recording is not allowed for the companion app.'
        return [{ type: 'image', source: { type: 'base64', media_type: shot.mediaType, data: shot.data } }]
      }
      case 'click': {
        const no = needTarget()
        if (no) return no
        const n = Number(input.element)
        const line = elementLine(n)
        if (!line) return `There is no element [${n}] in the latest look; look again.`
        if (RISKY_LABEL.test(line) && !(await deps.confirm(`Click ${line.replace(/^\[\d+\]\s*/, '')} in ${last?.app}?`))) {
          return 'The user said no. Do not click it; stop or ask what they want instead.'
        }
        deps.onStep(`clicking ${line.replace(/^\[\d+\]\s*/, '').slice(0, 40)}`)
        const r = await hands.act(n, 'press', target as string)
        await new Promise((res) => setTimeout(res, 500))
        return `Clicked ${line} (${r.via ?? 'press'}). Look to check what changed.`
      }
      case 'type_text': {
        const no = needTarget()
        if (no) return no
        const text = String(input.text)
        if (NEVER_TYPE.test(text)) return 'Refused: that looks like a password, card number or other secret. The user has to type it.'
        if (input.element !== null && input.element !== undefined) {
          const n = Number(input.element)
          const line = elementLine(n)
          if (!line) return `There is no element [${n}] in the latest look; look again.`
          if (line.includes('PasswordField')) return 'Refused: that is a password field. The user has to type it.'
          await hands.act(n, 'focus', target as string)
          await new Promise((res) => setTimeout(res, 200))
        }
        deps.onStep(`typing "${text.slice(0, 30)}${text.length > 30 ? '…' : ''}"`)
        await hands.paste(text, target as string)
        return 'Typed. Look to check it landed where you meant.'
      }
      case 'press_keys': {
        const no = needTarget()
        if (no) return no
        const combo = String(input.combo).toLowerCase().replace(/\s+/g, '')
        const sends = /^(?:cmd\+|ctrl\+|shift\+)?(?:return|enter)$/.test(combo) && MESSAGING_APPS.has(target as string)
        if (sends) {
          const where = last?.title ? ` in ${last.title}` : ''
          if (!(await deps.confirm(`Send that message${where}?`))) return 'The user said no. Do not send it.'
        }
        deps.onStep(`pressing ${combo}`)
        await hands.key(combo, target as string)
        await new Promise((res) => setTimeout(res, 350))
        return `Pressed ${combo}.`
      }
      case 'choose_menu': {
        const no = needTarget()
        if (no) return no
        const path = (input.path as string[]).map(String)
        if (RISKY_LABEL.test(path.join(' ')) && !(await deps.confirm(`Choose ${path.join(' › ')} in ${last?.app}?`))) {
          return 'The user said no.'
        }
        deps.onStep(`menu ${path.join(' › ')}`)
        const pressed = await hands.pressMenu(target as string, path, target as string)
        await new Promise((res) => setTimeout(res, 500))
        return `Chose ${pressed.join(' › ')}. Look to check.`
      }
      case 'send_message': {
        const result = await deps.runApp({ app: input.app as 'discord' | 'slack', action: 'message', to: String(input.to), text: String(input.text) })
        return result.ok ? `Done: ${result.summary}` : `Not sent: ${result.summary}`
      }
      case 'ask_claude_app': {
        const result = await deps.runApp({ app: 'claude', action: 'prompt', to: '', text: String(input.prompt) })
        return result.ok ? `Done: ${result.summary}` : `Not done: ${result.summary}`
      }
      case 'open_url': {
        const url = String(input.url)
        if (!/^https?:\/\//i.test(url)) return 'Only http(s) addresses.'
        deps.onStep(`opening ${url.replace(/^https?:\/\//, '').slice(0, 40)}`)
        await deps.openUrl(url)
        await new Promise((res) => setTimeout(res, 1500))
        return 'Opened. Use read_web_page or look to see it.'
      }
      case 'read_web_page':
        deps.onStep('reading the page')
        return (await deps.readWebPage()).slice(0, 8000)
      case 'ask_user': {
        const yes = await deps.confirm(String(input.question))
        return yes ? 'The user said yes.' : 'The user said no.'
      }
      default:
        return `Unknown tool ${name}.`
    }
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: `Goal: ${goal}` }]
  for (let step = 1; step <= maxSteps; step++) {
    if (deps.stopped()) return { ok: false, answer: 'Stopped.', steps: step - 1 }
    let res: Anthropic.Beta.BetaMessage
    try {
      res = await callClaude(deps.client, {
        model: deps.model,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages,
        tools: TOOLS,
        effort: deps.effort,
        maxTokens: 16000
      })
    } catch (err) {
      const e = err as ClaudeError
      deps.log(`claude: ${e.message}`)
      return { ok: false, answer: `Claude stopped on me: ${e.message}.`, steps: step - 1 }
    }
    // The whole content goes back (thinking and progress blocks included), so the history stays append-only.
    messages.push({ role: 'assistant', content: res.content })
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    const said = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim()
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      deps.log(`done after ${step - 1} tool round(s): ${said}`)
      return { ok: res.stop_reason === 'end_turn', answer: said || 'Done.', steps: step - 1 }
    }
    // Several calls in one turn run in order (they act on one screen); all results go back in one message.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const use of uses) {
      if (deps.stopped()) {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'The user said stop.', is_error: true })
        continue
      }
      deps.log(`tool ${use.name} ${JSON.stringify(use.input).slice(0, 200)}`)
      try {
        const content = await execute(use.name, use.input as Input)
        results.push({ type: 'tool_result', tool_use_id: use.id, content })
        deps.log(`  → ${typeof content === 'string' ? content.slice(0, 200).replace(/\n/g, ' | ') : '[image]'}`)
      } catch (err) {
        const message = err instanceof HandsError && err.code === 'focus_changed' ? `${err.message}. Someone switched apps; look again before acting.` : (err as Error).message
        results.push({ type: 'tool_result', tool_use_id: use.id, content: message, is_error: true })
        deps.log(`  ✗ ${message}`)
      }
    }
    messages.push({ role: 'user', content: results })
  }
  return { ok: false, answer: `I ran out of steps before finishing. I got as far as ${(last as Snapshot | null)?.app ?? 'the start'}.`, steps: maxSteps }
}
