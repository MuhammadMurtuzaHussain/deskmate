// A fake pair of hands for the agent core: every worker records its call and answers from a small made-up world
// (chats, files, a web page, the screen). Nothing is pressed, opened or sent. Used by test/core.test.ts and the eval.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryFiles, type MemorySection } from '../../src/main/memfiles.ts'
import { describeHits, PastIndex } from '../../src/main/past.ts'
import { changeJob, jobsLine, resolveSchedule, ScheduleStore, scheduledLine } from '../../src/main/schedule.ts'
import { describeGuide, findGuide, guideIndex, loadGuides, type Guide } from '../../src/main/skillmd.ts'
import type { Skill } from '../../src/main/skills.ts'
import type { ChatApp, JobAction, PastKind, ScheduleInput, ToolCtx, ToolOutcome, WorkerHost } from '../../src/main/tools.ts'
import { untrusted } from '../../src/main/untrusted.ts'
import { blockedPath, fileQuery, kindOf } from '../../src/main/channels/sendfile.ts'
import { checkCommand } from '../../src/main/shellsafe.ts'

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
  /** her notes as they are on disk: USER.md and MEMORY.md */
  notes?: { user?: string; memory?: string }
  /** what search_past can find: chats (you / her) and day-log lines (app, browse, plan…), days before "now" */
  past?: { daysAgo: number; kind: string; text: string; at?: string }[]
  /** instruction skills (SKILL.md) she has */
  guides?: { name: string; description: string; body: string }[]
  /** scheduled jobs already set up, in words ("every weekday at 9") */
  jobs?: { task: string; when: string }[]
  /** what is in ~/Downloads, oldest first */
  downloads?: { name: string; path: string }[]
  /** her activity log lately, as recent_actions shows it, oldest first */
  actions?: string[]
  /** the last thing she did that can be undone ("put Resume 2026.pdf back in Documents"); none when missing */
  undoable?: string
  /** what a terminal command prints */
  shellOutput?: string
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

  private readonly now: Date
  private home: string | null = null
  private mem: MemoryFiles | null = null
  readonly guides: Guide[] = []
  private past: PastIndex | null = null
  /** facts of importance 1–2 (they fade in the app) */
  readonly fading: string[] = []
  private store: ScheduleStore | null = null

  constructor(world: FakeWorld = {}, answer: (question: string) => boolean = () => true, now = new Date()) {
    this.world = world
    this.answer = answer
    this.now = now
    if (world.guides?.length) {
      const skillsDir = join(this.scratch(), 'skills')
      for (const g of world.guides) {
        mkdirSync(join(skillsDir, g.name), { recursive: true })
        writeFileSync(join(skillsDir, g.name, 'SKILL.md'), `---\nname: ${g.name}\ndescription: ${JSON.stringify(g.description)}\n---\n\n${g.body}\n`)
      }
      this.guides = loadGuides([{ dir: skillsDir, source: 'user' }]).guides
    }
  }

  /** Her notes, in a scratch folder made when first needed. */
  get memFiles(): MemoryFiles {
    if (!this.mem) {
      this.mem = new MemoryFiles(join(this.scratch(), 'memory'))
      this.mem.ensure()
      if (this.world.notes?.user) writeFileSync(this.mem.path('user'), this.world.notes.user)
      if (this.world.notes?.memory) writeFileSync(this.mem.path('memory'), this.world.notes.memory)
    }
    return this.mem
  }

  private scratch(): string {
    if (!this.home) this.home = mkdtempSync(join(tmpdir(), 'deskmate-fake-'))
    return this.home
  }

  /** What the agent core gets as its notes and skills list, as the app builds them. */
  prompt(): { memory: string; skills: string } {
    const files = this.world.notes ? this.memFiles.prompt() : ''
    return { memory: files ? `Your notes (yours to keep up to date with remember, update_memory and forget):\n${files}` : '', skills: guideIndex(this.guides) }
  }

  /** Removes the scratch folder. */
  dispose(): void {
    this.past?.close()
    this.store?.stop()
    if (this.home) rmSync(this.home, { recursive: true, force: true })
    this.home = null
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
    // DESKMATE_CONFIRM_SENDS=always, the default: every message is read back (unless the guard just asked about it).
    if (!ctx.approved && !(await ctx.confirm(`Send "${a.text}" to ${chat} on ${APP_NAMES[a.app]}?`))) return { ok: false, text: 'The user said no; not sent.', say: 'Okay, not sent.' }
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

  /** The scheduled jobs, in a scratch schedule.json, with the clock stopped at "now". */
  get schedule(): ScheduleStore {
    if (!this.store) {
      this.store = new ScheduleStore(join(this.scratch(), 'schedule.json'), () => {}, { now: () => this.now.getTime() })
      for (const j of this.world.jobs ?? []) {
        const r = resolveSchedule({ task: j.task, when: j.when, as_plan: false, kind: 'weekly', days: [], times: [], every_minutes: null, day_of_month: null, nth: null, between: null, at: null }, this.now)
        if ('rule' in r) this.store.add({ task: j.task, rule: r.rule, when: j.when })
      }
    }
    return this.store
  }

  async scheduleJob(a: ScheduleInput, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('schedule_job', a as unknown as Record<string, unknown>, ctx)
    const r = resolveSchedule(a, this.now)
    if ('error' in r) return { ok: false, text: r.error }
    const job = this.schedule.add({ task: a.task, rule: r.rule, when: a.when, mode: a.as_plan ? 'plan' : 'agent' })
    return this.ok(scheduledLine(job, this.now.getTime()))
  }

  async listJobs(ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('list_jobs', {}, ctx)
    return this.ok(jobsLine(this.schedule.list(), this.schedule.waiting(), this.now.getTime()))
  }

  async changeJob(a: { query: string; action: JobAction; when: string | null; task: string | null }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('change_job', a, ctx)
    const r = changeJob(this.schedule, a, this.now)
    return { ok: r.ok, text: r.text, say: r.text }
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

  async remember(a: { fact: string; importance: number; section: MemorySection }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('remember', a, ctx)
    if (a.importance < 3) {
      this.fading.push(a.fact)
      return this.ok('Kept for now.', '')
    }
    const r = this.memFiles.add(a.fact, a.section)
    return { ok: r.ok, text: r.text, say: '' }
  }

  async updateMemory(a: { old: string; new: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('update_memory', a, ctx)
    const r = this.memFiles.update(a.old, a.new)
    return { ok: r.ok, text: r.text, say: '' }
  }

  async forget(a: { what: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('forget', a, ctx)
    const r = this.memFiles.remove(a.what)
    return { ok: r.ok, text: r.text, say: '' }
  }

  async searchPast(a: { query: string; days_back: number | null; kind: PastKind }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('search_past', a, ctx)
    if (!this.past) {
      const dir = this.scratch()
      const day = (at: number): string => new Date(at).toISOString().slice(0, 10)
      for (const p of this.world.past ?? []) {
        const at = this.now.getTime() - p.daysAgo * 86_400_000 - 3_600_000
        const chat = p.kind === 'you' || p.kind === 'her'
        const sub = join(dir, chat ? 'chats' : 'log')
        mkdirSync(sub, { recursive: true })
        const line = chat ? { at, role: p.kind === 'her' ? 'assistant' : 'user', text: p.text } : { at, kind: p.kind, text: p.text }
        writeFileSync(join(sub, `${day(at)}.jsonl`), `${JSON.stringify(line)}\n`, { flag: 'a' })
      }
      this.past = new PastIndex(join(dir, 'past.db'), { chats: join(dir, 'chats'), journal: join(dir, 'log'), plans: join(dir, 'plans') })
    }
    const category = a.kind === 'any' ? undefined : a.kind
    const since = a.days_back ? this.now.getTime() - a.days_back * 86_400_000 - 86_400_000 : undefined
    let hits = this.past.search(a.query, { category, since, limit: 12 })
    if (!hits.length && since) hits = this.past.search(a.query, { category, limit: 8 })
    if (!hits.length) return this.ok(`Nothing about "${a.query}" in the chat archive, the day logs or the plans.`)
    return { ok: true, text: untrusted('past', describeHits(hits, this.now)), untrusted: 'past' }
  }

  async readSkill(a: { name: string; file: string | null }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('read_skill', a, ctx)
    const g = findGuide(this.guides, a.name)
    if (!g) return { ok: false, text: `No skill called ${a.name}. Skills: ${this.guides.map((x) => x.name).join(', ') || 'none'}.` }
    return this.ok(describeGuide(g), '')
  }

  async runSkillScript(a: { name: string; script: string; args: string[] }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('run_skill_script', a, ctx)
    return { ok: true, text: untrusted('skill', `ran ${a.script} ${a.args.join(' ')}`), untrusted: 'skill' }
  }

  async sendToMe(a: { what: 'screenshot' | 'file'; file: string | null }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('send_to_me', a, ctx)
    if (a.what === 'screenshot') return this.ok('Sent a screenshot of the screen to their phone.', "Here's your screen.")
    const desc = a.file ?? ''
    let hit: { name: string; path: string } | undefined
    if (/download/i.test(desc) || /\/Downloads\//.test(desc)) {
      const exts = kindOf(desc)
      hit = [...(this.world.downloads ?? [])].reverse().find((f) => (desc.startsWith('/') ? f.path === desc : !exts || exts.includes(f.name.toLowerCase().split('.').pop() ?? '')))
    } else {
      const q = fileQuery(desc).toLowerCase()
      hit = (this.world.files ?? []).find((f) => f.path === desc) ?? (this.world.files ?? []).find((f) => q.split(' ').every((w) => f.name.toLowerCase().includes(w)))
    }
    if (!hit) return { ok: false, text: `Not sent: nothing matches "${desc}".` }
    const blocked = blockedPath(hit.path)
    if (blocked) return { ok: false, text: `Not sent: ${blocked}.` }
    if (!(await ctx.confirm(`Send ${hit.name} (1.2 MB) to you on Telegram?`))) return { ok: false, text: 'The user said no; not sent.', say: 'Okay, not sent.' }
    return this.ok(`Sent ${hit.name} (${hit.path}) to their phone.`, `Sent ${hit.name}.`)
  }

  async moveFile(a: { from: string; to: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('move_file', a, ctx)
    const hit = (this.world.files ?? []).find((f) => f.path === a.from)
    if (!hit) return { ok: false, text: `Not moved: ${a.from} does not exist.` }
    if (ctx.mustConfirm && !(await ctx.confirm(`Move ${hit.name} to ${a.to}?`))) return { ok: false, text: 'The user said no; not moved.', refused: true }
    return { ok: true, text: `Moved ${a.from} to ${a.to}.`, say: `Moved ${hit.name}.`, undo: { kind: 'move', from: a.from, to: a.to } }
  }

  async trashFile(a: { path: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('trash_file', a, ctx)
    const hit = [...(this.world.files ?? []), ...(this.world.downloads ?? [])].find((f) => f.path === a.path)
    if (!hit) return { ok: false, text: `Not trashed: ${a.path} does not exist.` }
    return { ok: true, text: `Moved ${hit.name} to the Trash. It can be put back with "undo that".`, say: `${hit.name} is in the Trash.`, undo: { kind: 'trash', from: a.path, trashed: `/Users/me/.Trash/${hit.name}` } }
  }

  async runCommand(a: { command: string; folder: string | null }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('run_command', a, ctx)
    const verdict = checkCommand(a.command)
    if (!verdict.ok) return { ok: false, text: `Refused, not run: ${verdict.why}. Tell the user; do not try another way.` }
    return this.ok(this.world.shellOutput ?? '(no output)')
  }

  async recentActions(ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('recent_actions', {}, ctx)
    return this.ok(this.world.actions?.length ? this.world.actions.join('\n') : 'Nothing yet today.')
  }

  async undo(a: { what: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec('undo', a, ctx)
    if (!this.world.undoable) return { ok: false, text: 'Nothing I did lately can be undone (sent messages cannot be taken back).' }
    return this.ok(`Undone: ${this.world.undoable}.`)
  }

  async runSkill(skill: Skill, slots: Record<string, string>, ctx: ToolCtx): Promise<ToolOutcome> {
    this.rec(`skill:${skill.name}`, slots, ctx)
    const app = skill.app.name.toLowerCase() as 'whatsapp' | 'telegram'
    if (slots.to && this.world.chats?.[app] && !known(this.world.chats[app], slots.to)) return { ok: false, text: `I couldn't see a chat with ${slots.to} in ${skill.app.name}, so I didn't type anything.` }
    if (skill.steps.some((s) => s.do === 'confirm') && !(await ctx.confirm(`${skill.title}: ${JSON.stringify(slots)}?`))) return { ok: false, text: 'Okay, not sent.' }
    return this.ok(`Done: ${skill.title} ${JSON.stringify(slots)}.`)
  }
}
