import type Anthropic from '@anthropic-ai/sdk'
import { AVATAR_COMMANDS, type AvatarCommand } from '../shared/types.ts'
import { SECTIONS, type MemorySection } from './memfiles.ts'
import { isMessagingApp, skillTool, type Skill } from './skills.ts'
import type { Risk, Taint, UntrustedSource } from './untrusted.ts'

/**
 * Everything her hands can do, as tools for one brain. Each worker that used to sit behind its own regex (app
 * routines, Chrome, Claude Code jobs, the computer agent, files, reminders, plans, skills, MCP servers) is one entry
 * here: a name, a description and a strict input schema for Claude, a risk class for the injection guard, and a run
 * function that calls the worker through a WorkerHost. The real host lives in index.ts (Electron, her hands); the
 * eval and the tests use a fake one that records the calls.
 */

export interface ToolImage {
  data: string
  mediaType: 'image/jpeg' | 'image/png'
}

export interface ToolOutcome {
  ok: boolean
  /** what the brain reads back: facts, exact names, what to do next */
  text: string
  /** her own plain line about it, for when a fast path ran the tool and no model will phrase it */
  say?: string
  /** the result holds text from somewhere other than the user (it is wrapped already) */
  untrusted?: UntrustedSource
  image?: ToolImage
}

export type Origin = 'typed' | 'voice' | 'phone'

/** What a tool sees while it runs in a turn. */
export interface ToolCtx {
  origin: Origin
  taint: Taint
  /** true when this call is risky and the turn read untrusted text: a routine with its own read-back must use it */
  mustConfirm: boolean
  confirm(question: string): Promise<boolean>
  onStep(text: string): void
  log(line: string): void
  stopped(): boolean
}

export type ChatApp = 'discord' | 'slack' | 'messages'
export type SpotifyAction = 'play' | 'pause' | 'next' | 'previous' | 'now_playing' | 'play_query'
export type BrowserVerb = 'next_tab' | 'prev_tab' | 'close_tab' | 'back' | 'forward' | 'reload' | 'scroll_down' | 'scroll_up' | 'search' | 'find_on_page' | 'click'
export type Repeat = 'none' | 'hourly' | 'daily' | 'weekdays' | 'weekly'

/** The workers, as index.ts (or a fake) provides them. */
export interface WorkerHost {
  sendMessage(a: { app: ChatApp; to: string; text: string; photo: boolean }, ctx: ToolCtx): Promise<ToolOutcome>
  openChat(a: { app: 'discord' | 'slack'; to: string }, ctx: ToolCtx): Promise<ToolOutcome>
  spotify(a: { action: SpotifyAction; query: string }, ctx: ToolCtx): Promise<ToolOutcome>
  askClaudeApp(a: { prompt: string }, ctx: ToolCtx): Promise<ToolOutcome>
  claudeCode(a: { instruction: string; folder: string | null; resume: boolean }, ctx: ToolCtx): Promise<ToolOutcome>
  claudeJobs(a: { action: 'status' | 'cancel' }, ctx: ToolCtx): Promise<ToolOutcome>
  browse(a: { goal: string }, ctx: ToolCtx): Promise<ToolOutcome>
  readPage(ctx: ToolCtx): Promise<ToolOutcome>
  browserTab(a: { verb: BrowserVerb; text: string }, ctx: ToolCtx): Promise<ToolOutcome>
  open(a: { target: string }, ctx: ToolCtx): Promise<ToolOutcome>
  findFile(a: { query: string }, ctx: ToolCtx): Promise<ToolOutcome>
  useComputer(a: { goal: string }, ctx: ToolCtx): Promise<ToolOutcome>
  seeScreen(ctx: ToolCtx): Promise<ToolOutcome>
  setReminder(a: { text: string; in_minutes: number | null; at: string | null; timer: boolean; repeat: Repeat }, ctx: ToolCtx): Promise<ToolOutcome>
  listReminders(ctx: ToolCtx): Promise<ToolOutcome>
  cancelReminder(a: { query: string; all: boolean }, ctx: ToolCtx): Promise<ToolOutcome>
  makePlan(a: { goal: string }, ctx: ToolCtx): Promise<ToolOutcome>
  calendar(a: { which: 'today' | 'tomorrow' | 'next' }, ctx: ToolCtx): Promise<ToolOutcome>
  recallDay(a: { day: 'today' | 'yesterday' }, ctx: ToolCtx): Promise<ToolOutcome>
  /** the notifications she saw lately (messages, mail), newest last */
  recentMessages(ctx: ToolCtx): Promise<ToolOutcome>
  move(a: { action: AvatarCommand }, ctx: ToolCtx): Promise<ToolOutcome>
  remember(a: { fact: string; importance: number; section: MemorySection }, ctx: ToolCtx): Promise<ToolOutcome>
  updateMemory(a: { old: string; new: string }, ctx: ToolCtx): Promise<ToolOutcome>
  forget(a: { what: string }, ctx: ToolCtx): Promise<ToolOutcome>
  /** the chat archive, the day logs and the plans, searched (past.ts) */
  searchPast(a: { query: string; days_back: number | null; kind: PastKind }, ctx: ToolCtx): Promise<ToolOutcome>
  runSkill(skill: Skill, slots: Record<string, string>, ctx: ToolCtx): Promise<ToolOutcome>
  /** a SKILL.md's instructions, or one of the files beside it */
  readSkill(a: { name: string; file: string | null }, ctx: ToolCtx): Promise<ToolOutcome>
  /** one of a skill's scripts (only with DESKMATE_SKILL_CODE=1 and the user's yes for that skill) */
  runSkillScript(a: { name: string; script: string; args: string[] }, ctx: ToolCtx): Promise<ToolOutcome>
}

export type PastKind = 'any' | 'chat' | 'did' | 'plans'

/** A tool from a connected MCP server, as mcp.ts lists it. */
export interface ExternalTool {
  /** the namespaced name the brain sees ("github__create_issue") */
  name: string
  server: string
  tool: string
  description: string
  inputSchema: Record<string, unknown>
  /** the server says it only reads (MCP readOnlyHint) */
  readOnly: boolean
  call(args: Record<string, unknown>): Promise<ToolOutcome>
}

type Input = Record<string, unknown>

export interface ToolSpec {
  name: string
  description: string
  input_schema: Anthropic.Beta.BetaTool['input_schema']
  strict: boolean
  /** what could go wrong if someone tricked her into it; asked about in a turn that read untrusted text */
  risk?: Risk | ((input: Input) => Risk | null)
  /** the worker reads its own yes before the risky part (a message read-back): the guard turns that on instead of
   * asking twice */
  selfConfirm?: boolean
  /** the action, starting with a verb, for the guard's question */
  describe?(input: Input): string
  /** takes a while (an agent run, a browse, a job): her first line is spoken before it starts */
  slow?: boolean
  run(input: Input, ctx: ToolCtx): Promise<ToolOutcome>
}

const str = { type: 'string' }
const nullable = (t: Record<string, unknown>): Record<string, unknown> => ({ anyOf: [t, { type: 'null' }] })

function schema(properties: Record<string, unknown>): Anthropic.Beta.BetaTool['input_schema'] {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
}

const s = (v: unknown): string => String(v ?? '').trim()

export interface ToolsOptions {
  skills?: Skill[]
  /** instruction skills (SKILL.md) are loaded: read_skill is in the list; `scripts` adds run_skill_script */
  guides?: { any: boolean; scripts: boolean }
  external?: ExternalTool[]
  /** workers this computer can use right now; a missing one is left out of the list */
  has?: Partial<Record<'computer' | 'chrome' | 'claudeCode' | 'apps', boolean>>
}

/** The tool list for one brain, in a fixed order (it is part of the cached prompt prefix). */
export function buildTools(host: WorkerHost, opts: ToolsOptions = {}): ToolSpec[] {
  const has = { computer: true, chrome: true, claudeCode: true, apps: true, ...opts.has }
  const tools: ToolSpec[] = []
  const add = (t: Omit<ToolSpec, 'strict'> & { strict?: boolean }): void => {
    tools.push({ strict: true, ...t })
  }

  if (has.apps) {
    add({
      name: 'send_message',
      description:
        'Send a message to a person, channel or group chat on Discord, Slack or Messages (iMessage / texts). It opens the app, finds the chat, checks it is the right one, and reads the message back to the user before sending. "to" is only the name ("sam", "#general", "Mum"); "text" is exactly the words to send, as the user wants them to read (no "saying", no quotes, nothing added). photo: also send a picture of you, the companion.',
      input_schema: schema({ app: { type: 'string', enum: ['discord', 'slack', 'messages'] }, to: str, text: str, photo: { type: 'boolean' } }),
      risk: 'send',
      selfConfirm: true,
      describe: (i) => `send "${s(i.text)}" to ${s(i.to)} on ${s(i.app)}`,
      run: (i, ctx) => host.sendMessage({ app: i.app as ChatApp, to: s(i.to), text: s(i.text), photo: Boolean(i.photo) }, ctx)
    })
    add({
      name: 'open_chat',
      description: 'Go to a chat or channel in Discord or Slack without sending anything.',
      input_schema: schema({ app: { type: 'string', enum: ['discord', 'slack'] }, to: str }),
      run: (i, ctx) => host.openChat({ app: i.app as 'discord' | 'slack', to: s(i.to) }, ctx)
    })
    add({
      name: 'spotify',
      description: 'Spotify: play, pause, next, previous, now_playing (what is playing), or play_query to find and play a song, artist, album or playlist named in "query" ("" for the other actions).',
      input_schema: schema({ action: { type: 'string', enum: ['play', 'pause', 'next', 'previous', 'now_playing', 'play_query'] }, query: str }),
      run: (i, ctx) => host.spotify({ action: i.action as SpotifyAction, query: s(i.query) }, ctx)
    })
    add({
      name: 'ask_claude_app',
      description: 'Type a prompt into a new chat in the Claude desktop app and send it ("ask the Claude app …"). Not for coding jobs: those are claude_code.',
      input_schema: schema({ prompt: str }),
      risk: 'external',
      selfConfirm: true,
      describe: (i) => `ask the Claude app "${s(i.prompt).slice(0, 80)}"`,
      run: (i, ctx) => host.askClaudeApp({ prompt: s(i.prompt) }, ctx)
    })
  }
  if (has.claudeCode) {
    add({
      name: 'claude_code',
      description:
        'Start a Claude Code job (the coding agent installed on this computer) in a project folder: write or fix code, edit a video project, change files, run a build. It runs in the background and reports when it is done. "instruction" is what the user asked for, in plain words, nothing added; "folder" is the project they named ("deskmate", "the vlog") or null for the current one; resume: continue the last session there instead of starting fresh.',
      input_schema: schema({ instruction: str, folder: nullable(str), resume: { type: 'boolean' } }),
      risk: 'shell',
      selfConfirm: true,
      slow: true,
      describe: (i) => `start a Claude Code job${i.folder ? ` in ${s(i.folder)}` : ''}: ${s(i.instruction).slice(0, 100)}`,
      run: (i, ctx) => host.claudeCode({ instruction: s(i.instruction), folder: i.folder ? s(i.folder) : null, resume: Boolean(i.resume) }, ctx)
    })
    add({
      name: 'claude_jobs',
      description: 'How the Claude Code jobs are doing (status), or stop the running one (cancel).',
      input_schema: schema({ action: { type: 'string', enum: ['status', 'cancel'] } }),
      strict: false,
      run: (i, ctx) => host.claudeJobs({ action: i.action === 'cancel' ? 'cancel' : 'status' }, ctx)
    })
  }
  if (has.chrome) {
    add({
      name: 'browse',
      description:
        "Do or look something up in the user's Chrome, logged in as them: search the web, open a site and dig for an answer, follow links, fill a form. Returns what was found. Give the whole goal with every detail. Not for questions you can answer yourself.",
      input_schema: schema({ goal: str }),
      slow: true,
      run: (i, ctx) => host.browse({ goal: s(i.goal) }, ctx)
    })
    add({
      name: 'read_page',
      description: 'Read the text of the web page open in Chrome right now, to answer a question about it or summarize it.',
      input_schema: schema({}),
      run: (_i, ctx) => host.readPage(ctx)
    })
    add({
      name: 'browser_tab',
      description: 'Quick Chrome verbs on the front tab: next_tab, prev_tab, close_tab, back, forward, reload, scroll_down, scroll_up, search (a web search for "text"), find_on_page ("text"), click (the link or button labelled "text"). "text" is "" when the verb needs none.',
      input_schema: schema({ verb: { type: 'string', enum: ['next_tab', 'prev_tab', 'close_tab', 'back', 'forward', 'reload', 'scroll_down', 'scroll_up', 'search', 'find_on_page', 'click'] }, text: str }),
      risk: (i) => (i.verb === 'click' && /\b(send|post|delete|remove|buy|pay|purchase|checkout|order|transfer|subscribe|confirm)\b/i.test(s(i.text)) ? 'external' : null),
      describe: (i) => `click "${s(i.text)}" in Chrome`,
      run: (i, ctx) => host.browserTab({ verb: i.verb as BrowserVerb, text: s(i.text) }, ctx)
    })
  }
  add({
    name: 'open',
    description: 'Open an app, a website, a project folder or a file path by name ("Spotify", "github.com", "the vlog folder", "~/Downloads/report.pdf").',
    input_schema: schema({ target: str }),
    run: (i, ctx) => host.open({ target: s(i.target) }, ctx)
  })
  add({
    name: 'find_file',
    description: 'Find a file or folder on this Mac by what it is called or what it is ("resume", "tax pdf", "the invoice from march"). Shows the best match in Finder, points at it, and returns its full path (pass that path to open to open it).',
    input_schema: schema({ query: str }),
    run: (i, ctx) => host.findFile({ query: s(i.query) }, ctx)
  })
  if (has.computer) {
    add({
      name: 'use_computer',
      description:
        "Work any app on this Mac step by step with the companion's hands (look at the window, click, type, press keys, pick menus), for what no other tool covers: WhatsApp or Telegram without a skill, Notes, Finder, Mail, Calendar, Notion, settings inside an app, playing a specific thing in Spotify. Give the whole goal with every detail, including the exact words to type or send. It asks the user before anything is sent, posted, deleted or bought.",
      input_schema: schema({ goal: str }),
      slow: true,
      run: (i, ctx) => host.useComputer({ goal: s(i.goal) }, ctx)
    })
    add({
      name: 'see_screen',
      description: "Look at the user's screen (a screenshot), when they ask about something on it and none was attached.",
      input_schema: schema({}),
      run: (_i, ctx) => host.seeScreen(ctx)
    })
  }
  add({
    name: 'set_reminder',
    description:
      'Remind the user of something later, or start a timer. Give in_minutes (a length of time from now: "in 20 minutes" is 20) or at (a local clock time "YYYY-MM-DDTHH:MM"), the other null. "text" is what to remind them of in second person ("call your mum"), or the timer\'s label. timer: true for a timer. repeat: none, hourly, daily, weekdays or weekly when they say "every …".',
    input_schema: schema({
      text: str,
      in_minutes: nullable({ type: 'number' }),
      at: nullable(str),
      timer: { type: 'boolean' },
      repeat: { type: 'string', enum: ['none', 'hourly', 'daily', 'weekdays', 'weekly'] }
    }),
    run: (i, ctx) =>
      host.setReminder(
        {
          text: s(i.text),
          in_minutes: typeof i.in_minutes === 'number' ? i.in_minutes : null,
          at: i.at ? s(i.at) : null,
          timer: Boolean(i.timer),
          repeat: (['hourly', 'daily', 'weekdays', 'weekly'].includes(String(i.repeat)) ? i.repeat : 'none') as Repeat
        },
        ctx
      )
  })
  add({
    name: 'list_reminders',
    description: 'The reminders and timers that are set.',
    input_schema: schema({}),
    run: (_i, ctx) => host.listReminders(ctx)
  })
  add({
    name: 'cancel_reminder',
    description: 'Cancel a reminder or timer by words that name it ("stretch"), or all of them (all: true, query "").',
    input_schema: schema({ query: str, all: { type: 'boolean' } }),
    risk: 'delete',
    describe: (i) => (i.all ? 'cancel all your reminders' : `cancel the "${s(i.query)}" reminder`),
    run: (i, ctx) => host.cancelReminder({ query: s(i.query), all: Boolean(i.all) }, ctx)
  })
  add({
    name: 'make_plan',
    description:
      'For a bigger goal with several distinct parts that need different tools one after another, when the user asks for a plan or wants to see the steps first ("make a plan to …", "set up my morning: Slack, calendar, music"). Shows a card with the steps and waits for their go. For a request of two or three clear steps, just do them with the other tools instead.',
    input_schema: schema({ goal: str }),
    run: (i, ctx) => host.makePlan({ goal: s(i.goal) }, ctx)
  })
  add({
    name: 'calendar',
    description: "The user's calendar events: today, tomorrow, or the next one.",
    input_schema: schema({ which: { type: 'string', enum: ['today', 'tomorrow', 'next'] } }),
    strict: false,
    run: (i, ctx) => host.calendar({ which: (['tomorrow', 'next'].includes(String(i.which)) ? i.which : 'today') as 'today' | 'tomorrow' | 'next' }, ctx)
  })
  add({
    name: 'recall_day',
    description: 'Your log of what you did for the user today or yesterday (messages sent, jobs run, files found).',
    input_schema: schema({ day: { type: 'string', enum: ['today', 'yesterday'] } }),
    strict: false,
    run: (i, ctx) => host.recallDay({ day: i.day === 'yesterday' ? 'yesterday' : 'today' }, ctx)
  })
  add({
    name: 'recent_messages',
    description: 'The message and mail notifications that came in lately (who, which app, and what they said when the user lets you read it), newest last.',
    input_schema: schema({}),
    run: (_i, ctx) => host.recentMessages(ctx)
  })
  add({
    name: 'move',
    description:
      'Move your body on their screen, only when they ask you to: dance, dance_slow (slow or sensual), spin, stop_dancing, next_outfit, come_here (walk over to their pointer), go_home, sit (on the window in front), lie (lie down on it), peek (hide behind the screen edge and peek out), stand, sleep, wake, wander (walk around now and then), stay.',
    input_schema: schema({ action: { type: 'string', enum: [...AVATAR_COMMANDS] } }),
    run: (i, ctx) => host.move({ action: i.action as AvatarCommand }, ctx)
  })
  // Memory writes come only from the user: a fact picked up while reading someone else's text could be planted there.
  const fromUser = (ctx: ToolCtx): ToolOutcome | null =>
    ctx.taint.tainted ? { ok: false, text: 'Not changed: this turn read untrusted text, and your memory only takes what the user tells you.' } : null
  add({
    name: 'remember',
    description:
      'Keep something about the user for later conversations. importance: 1–2 small talk (fades in days), 3 useful, 4 important, 5 defining; 3 and up go into your notes (USER.md / MEMORY.md, shown to you every turn). section: who (about them), preferences (likes, habits, how they want things done), people (who they message and who those people are), projects (what they work on, where), facts (other things that stay true), lessons (what worked or failed when you did something for them, app quirks). One short fact in plain words. Only for things worth keeping.',
    input_schema: schema({ fact: str, importance: { type: 'integer', enum: [1, 2, 3, 4, 5] }, section: { type: 'string', enum: SECTIONS.map((x) => x.id) } }),
    run: async (i, ctx) => fromUser(ctx) ?? host.remember({ fact: s(i.fact), importance: Number(i.importance) || 2, section: (SECTIONS.some((x) => x.id === i.section) ? i.section : 'facts') as MemorySection }, ctx)
  })
  add({
    name: 'update_memory',
    description: 'Change one of your notes that is wrong, out of date, or says the same as another: "old" is a few words from the note as it is now, "new" the whole note as it should read (merge two notes by updating one and forgetting the other).',
    input_schema: schema({ old: str, new: str }),
    strict: false,
    run: async (i, ctx) => fromUser(ctx) ?? host.updateMemory({ old: s(i.old), new: s(i.new) }, ctx)
  })
  add({
    name: 'forget',
    description: 'Drop one of your notes, when the user asks you to forget something or it stopped being true: "what" is a few words from the note.',
    input_schema: schema({ what: str }),
    strict: false,
    run: async (i, ctx) => fromUser(ctx) ?? host.forget({ what: s(i.what) }, ctx)
  })
  add({
    name: 'search_past',
    description:
      'Search everything from before the recent conversation: what the user said to you and you said back (chat), what you did for them (did: messages sent, jobs, files, browsing, reminders), and plans with their results (plans). For "what did I ask you about the dentist last week", "what did you send sam yesterday", "when did we talk about the trip". query: the few words that matter ("dentist", "sam"), or "" for everything in the time window; days_back: how far back to look (1 = since yesterday), null for all time; kind: any, chat, did or plans. Results come with dates.',
    input_schema: schema({ query: str, days_back: nullable({ type: 'integer' }), kind: { type: 'string', enum: ['any', 'chat', 'did', 'plans'] } }),
    strict: false,
    run: (i, ctx) =>
      host.searchPast(
        { query: s(i.query), days_back: typeof i.days_back === 'number' && i.days_back > 0 ? Math.round(i.days_back) : null, kind: (['chat', 'did', 'plans'].includes(String(i.kind)) ? i.kind : 'any') as PastKind },
        ctx
      )
  })
  if (opts.guides?.any) {
    add({
      name: 'read_skill',
      description: 'Load one of your skills (listed in your notes under Skills) before doing the task it covers: its step-by-step instructions, app quirks and edge cases. file: null for the instructions, or the path of a file the skill lists (a reference or template).',
      input_schema: schema({ name: str, file: nullable(str) }),
      strict: false,
      run: (i, ctx) => host.readSkill({ name: s(i.name), file: i.file ? s(i.file) : null }, ctx)
    })
  }
  if (opts.guides?.scripts) {
    add({
      name: 'run_skill_script',
      description: "Run one of a skill's own scripts, when its instructions say to: name the skill, the script's path inside it (\"scripts/export.sh\") and its arguments. The user approves each skill's scripts once.",
      input_schema: schema({ name: str, script: str, args: { type: 'array', items: str } }),
      strict: false,
      risk: 'shell',
      describe: (i) => `run ${s(i.script)} from the ${s(i.name)} skill`,
      slow: true,
      run: (i, ctx) => host.runSkillScript({ name: s(i.name), script: s(i.script), args: Array.isArray(i.args) ? i.args.map((a) => String(a)).slice(0, 20) : [] }, ctx)
    })
  }

  for (const skill of opts.skills ?? []) {
    const def = skillTool(skill)
    const messaging = isMessagingApp(skill.app)
    tools.push({
      name: def.name,
      description: def.description,
      input_schema: def.input_schema,
      strict: true,
      risk: messaging ? 'send' : undefined,
      selfConfirm: true,
      describe: () => `run "${skill.title}" in ${skill.app.name}`,
      run: (i, ctx) => host.runSkill(skill, Object.fromEntries(Object.entries(i).map(([k, v]) => [k, s(v)])), ctx)
    })
  }

  for (const ext of opts.external ?? []) {
    tools.push({
      name: ext.name,
      description: `[${ext.server}, a connected tool server] ${ext.description}`.slice(0, 1024),
      input_schema: (ext.inputSchema?.type === 'object' ? ext.inputSchema : { type: 'object', properties: {} }) as Anthropic.Beta.BetaTool['input_schema'],
      strict: false,
      // A server that does not say it only reads may write, send or delete somewhere: guarded like a send.
      risk: ext.readOnly ? undefined : 'external',
      describe: (i) => `use ${ext.tool} on ${ext.server} with ${JSON.stringify(i).slice(0, 120)}`,
      run: async (i) => {
        const out = await ext.call(i)
        return { ...out, untrusted: 'mcp' }
      }
    })
  }
  return tools
}

/** The API takes at most this many strict tools in one request. */
export const STRICT_LIMIT = 20

/** The tools as the Messages API takes them: strict where it was asked for and the tool has inputs, in list order,
 * up to the API's limit (the rest are sent without strict and still validated by their schema's shape). */
export function apiTools(tools: ToolSpec[]): Anthropic.Beta.BetaTool[] {
  let strict = 0
  return tools.map((t) => {
    const hasInputs = Object.keys((t.input_schema.properties ?? {}) as object).length > 0
    const on = t.strict && hasInputs && strict < STRICT_LIMIT
    if (on) strict++
    return { name: t.name, description: t.description, input_schema: t.input_schema, ...(on ? { strict: true } : {}) }
  })
}

