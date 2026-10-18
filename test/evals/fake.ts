// A fake pair of hands for the agent core: every worker records its call and answers from a small made-up world
// (chats, files, a web page, the screen). Nothing is pressed, opened or sent. Used by test/core.test.ts and the eval.
import type { Skill } from '../../src/main/skills.ts'
import type { ChatApp, ToolCtx, ToolOutcome, WorkerHost } from '../../src/main/tools.ts'
import { untrusted } from '../../src/main/untrusted.ts'

export interface FakeWorld {
  /** chat names each app knows; a name not here is "not found" */
  chats?: Partial<Record<ChatApp | 'whatsapp' | 'telegram', string[]>>
  files?: { name: string; path: string }[]
  projects?: string[]
  /** the page open in Chrome */
  page?: { url: string; title: string; text: string }
  /** what a browse run finds */
  browseFinds?: string
  /** the front window's text, for use_computer and see_screen */
  screen?: string
  /** notifications that came in lately */
  messages?: string[]
  calendar?: string
  journal?: string
  reminders?: string[]
}

export interface HostCall {
  tool: string
  input: Record<string, unknown>
  /** the guard forced the read-back on */
  mustConfirm: boolean
}

const APP_NAMES: Record<string, string> = { discord: 'Discord', slack: 'Slack', messages: 'Messages' }

function known(list: string[] | undefined, name: string): string | null {
  if (!list) return name
  const want = name.toLowerCase().replace(/^[#@]/, '')
  return list.find((c) => c.toLowerCase().replace(/^[#@]/, '') === want) ?? list.find((c) => c.toLowerCase().includes(want)) ?? null
}

export class FakeHost implements WorkerHost {
  readonly calls: HostCall[] = []
  /** every question read to the user, in order */
  readonly asked: string[] = []
  private readonly world: FakeWorld
  /** what the user answers to a read-back */
  answer: (question: string) => boolean

  constructor(world: FakeWorld = {}, answer: (question: string) => boolean = () => true) {
    this.world = world
    this.answer = answer
  }

  /** The confirm function to give the core; it records the question. */
  confirm = async (question: string): Promise<boolean> => {
    this.asked.push(question)
    return this.answer(question)
  }

  private rec(tool: string, input: Record<string, unknown>, ctx: ToolCtx): void {
    this.calls.push({ tool, input, mustConfirm: ctx.mustConfirm })
  }

  private ok(text: string, say = text): ToolOutcome {
    return { ok: true, text, say }
  }

  async sendMessage(a: { app: ChatApp; to: string; text: string; photo: boolean }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('send_message', a, ctx)
    const chat = known(this.world.chats?.[a.app], a.to)
    if (!chat) return { ok: false, text: `There is no chat called ${a.to} in ${APP_NAMES[a.app]}; nothing was sent.` }
    // DESKMATE_CONFIRM_SENDS=always, the default: every message is read back.
    if (!(await ctx.confirm(`Send "${a.text}" to ${chat} on ${APP_NAMES[a.app]}?`))) return { ok: false, text: 'The user said no; not sent.', say: 'Okay, not sent.' }
    return this.ok(`Sent "${a.text}" to ${chat} on ${APP_NAMES[a.app]}${a.photo ? ' with a photo of you' : ''}.`, `Sent to ${chat}.`)
  }

  async openChat(a: { app: 'discord' | 'slack'; to: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('open_chat', a, ctx)
    return this.ok(`Opened ${a.to} in ${APP_NAMES[a.app]}.`)
  }

  async spotify(a: { action: string; query: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('spotify', a, ctx)
    if (a.action === 'now_playing') return this.ok("It's Midnight City by M83.")
    if (a.action === 'play_query') return this.ok(`Playing ${a.query}.`)
    return this.ok(`Spotify: ${a.action}.`)
  }

  async askClaudeApp(a: { prompt: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('ask_claude_app', a, ctx)
    if (ctx.mustConfirm && !(await ctx.confirm(`Ask the Claude app: ${a.prompt}?`))) return { ok: false, text: 'The user said no.' }
    return this.ok('Asked the Claude app; its answer is on screen.')
  }

  async claudeCode(a: { instruction: string; folder: string | null; resume: boolean }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('claude_code', a, ctx)
    const projects = this.world.projects ?? ['deskmate']
    const folder = a.folder ? projects.find((p) => p.toLowerCase().includes(a.folder!.toLowerCase().replace(/^the /, ''))) : projects[0]
    if (!folder) return { ok: false, text: `I don't know a project called ${a.folder}. Known: ${projects.join(', ')}.` }
    if ((ctx.origin === 'voice' || ctx.mustConfirm) && !(await ctx.confirm(`Send this to Claude in ${folder}: ${a.instruction}?`))) return { ok: false, text: 'The user said no; no job started.' }
    return this.ok(`Started a Claude Code job in ${folder}: ${a.instruction}. It reports back when it is done.`)
  }

  async claudeJobs(a: { action: 'status' | 'cancel' }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('claude_jobs', a, ctx)
    return this.ok(a.action === 'status' ? 'No Claude jobs are running.' : "Nothing's running right now.")
  }

  async browse(a: { goal: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('browse', a, ctx)
    const found = this.world.browseFinds ?? 'Nothing useful came up.'
    return { ok: true, text: `Goal: ${a.goal}\nFound:\n${untrusted('web', found, 'the web')}`, untrusted: 'web' }
  }

  async readPage(ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('read_page', {}, ctx)
    const p = this.world.page
    if (!p) return { ok: false, text: 'Chrome has no page open.' }
    return { ok: true, text: `${p.title}\n${p.url}\n${untrusted('web', p.text, p.url)}`, untrusted: 'web' }
  }

  async browserTab(a: { verb: string; text: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('browser_tab', a, ctx)
    return this.ok(`Chrome: ${a.verb}${a.text ? ` ${a.text}` : ''}.`)
  }

  async open(a: { target: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('open', a, ctx)
    return this.ok(`Opened ${a.target}.`)
  }

  async findFile(a: { query: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('find_file', a, ctx)
    const words = a.query.toLowerCase().split(/\W+/).filter((w) => w.length > 1 && !['my', 'the', 'file'].includes(w))
    const hit = (this.world.files ?? []).find((f) => words.some((w) => f.name.toLowerCase().includes(w)))
    if (!hit) return { ok: false, text: `Nothing called ${a.query} on this Mac.` }
    return this.ok(`Found ${hit.name} at ${hit.path}; it is selected in Finder and I'm pointing at it.`, `It's ${hit.name}.`)
  }

  async useComputer(a: { goal: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('use_computer', a, ctx)
    const seen = this.world.screen ? `\nWhat was on screen:\n${untrusted('screen', this.world.screen)}` : ''
    return { ok: true, text: `Done: ${a.goal}${seen}`, untrusted: 'screen' }
  }

  async seeScreen(ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('see_screen', {}, ctx)
    return { ok: true, text: untrusted('screen', this.world.screen ?? 'A desktop with no windows open.'), untrusted: 'screen' }
  }

  async setReminder(a: { text: string; in_minutes: number | null; at: string | null; timer: boolean; repeat: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('set_reminder', a, ctx)
    if (a.in_minutes === null && !a.at) return { ok: false, text: 'Give in_minutes or at.' }
    const when = a.in_minutes !== null ? `in ${a.in_minutes} minutes` : `at ${a.at}`
    return this.ok(`Set: ${a.timer ? 'timer' : 'reminder'} "${a.text}" ${when}${a.repeat !== 'none' ? `, repeating ${a.repeat}` : ''}.`)
  }

  async listReminders(ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('list_reminders', {}, ctx)
    const list = this.world.reminders ?? []
    return this.ok(list.length ? list.join('; ') : 'No reminders or timers.')
  }

  async cancelReminder(a: { query: string; all: boolean }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('cancel_reminder', a, ctx)
    return this.ok(a.all ? 'Cancelled all reminders.' : `Cancelled the reminder to ${a.query}.`)
  }

  async makePlan(a: { goal: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('make_plan', a, ctx)
    return this.ok(`A plan with 3 steps for "${a.goal}" is on the card beside you, waiting for the user's go. Tell them it is ready.`)
  }

  async calendar(a: { which: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('calendar', a, ctx)
    return this.ok(this.world.calendar ?? `Nothing on the calendar ${a.which}.`)
  }

  async recallDay(a: { day: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('recall_day', a, ctx)
    return this.ok(this.world.journal ?? '(nothing logged)')
  }

  async recentMessages(ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('recent_messages', {}, ctx)
    const list = this.world.messages ?? []
    if (!list.length) return this.ok('No new messages.')
    return { ok: true, text: list.map((m) => untrusted('message', m)).join('\n'), untrusted: 'message' }
  }

  async move(a: { action: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('move', a, ctx)
    return this.ok(`Moving: ${a.action}.`)
  }

  async remember(a: { fact: string; importance: number }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('remember', a, ctx)
    return this.ok('Kept.')
  }

  async runSkill(skill: Skill, slots: Record<string, string>, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec(`skill:${skill.name}`, slots, ctx)
    const app = skill.app.name.toLowerCase() as 'whatsapp' | 'telegram'
    if (slots.to && this.world.chats?.[app] && !known(this.world.chats[app], slots.to)) return { ok: false, text: `I couldn't see a chat with ${slots.to} in ${skill.app.name}, so I didn't type anything.` }
    if (skill.steps.some((s) => s.do === 'confirm') && !(await ctx.confirm(`${skill.title}: ${JSON.stringify(slots)}?`))) return { ok: false, text: 'Okay, not sent.' }
    return this.ok(`Done: ${skill.title} ${JSON.stringify(slots)}.`)
  }
}
