import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import type { TaskInfo } from '../shared/types'

export interface RunOptions {
  prompt: string
  cwd: string
  title?: string
  /** 'last' continues the most recent Claude Code conversation in that folder; a session id resumes that one */
  resume?: 'last' | string
}

export interface Task extends TaskInfo {
  prompt: string
  /** Claude's latest spoken line */
  lastText?: string
  /** the tool Claude is using right now, for the status row */
  lastTool?: string
  /** Claude's final message */
  result?: string
  error?: string
  costUsd?: number
  turns?: number
}

interface StreamEvent {
  type: string
  subtype?: string
  session_id?: string
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>; model?: string }
  result?: string
  is_error?: boolean
  terminal_reason?: string
  total_cost_usd?: number
  num_turns?: number
}

const MAX_TASKS = 30

/**
 * Her hands: runs Claude Code (the `claude` CLI already installed and logged in on this machine) as a
 * non-interactive job in a project folder, follows its stream-json output, and keeps a list of jobs so she
 * can report on them, resume them, or stop them. Deskmate's own brain stays Gemini or Ollama; Claude is the
 * tool she reaches for when the user asks for real work.
 *
 * Events: 'start' (task), 'progress' (task), 'end' (task; status says done/failed/cancelled).
 */
export class Agent extends EventEmitter {
  private readonly tasks: Task[] = []
  private readonly children = new Map<string, ChildProcess>()
  private binary: string | null | undefined
  /** `--permission-mode` for Claude: acceptEdits lets it edit files in the project without asking; it still
   * cannot run commands outside its allow list unless the user sets DESKMATE_CLAUDE_PERMISSION_MODE=bypassPermissions. */
  readonly permissionMode = process.env.DESKMATE_CLAUDE_PERMISSION_MODE?.trim() || 'acceptEdits'

  constructor(private readonly logDir: string) {
    super()
  }

  /** The Claude Code CLI: DESKMATE_CLAUDE_BIN, else PATH, else the usual install spots. */
  findBinary(): string | null {
    if (this.binary !== undefined) return this.binary
    const fromEnv = process.env.DESKMATE_CLAUDE_BIN?.trim()
    const names = process.platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude']
    const dirs = [...(process.env.PATH ?? '').split(delimiter), ...extraPathDirs()].filter(Boolean)
    const candidates = fromEnv ? [fromEnv] : dirs.flatMap((d) => names.map((n) => join(d, n)))
    this.binary = candidates.find((p) => existsSync(p)) ?? null
    return this.binary
  }

  async check(): Promise<{ ok: boolean; version?: string; error?: string }> {
    const bin = this.findBinary()
    if (!bin) return { ok: false, error: 'Claude Code is not installed (or not on PATH). See docs/AGENT.md.' }
    return new Promise((resolve) => {
      execFile(bin, ['--version'], { env: childEnv(bin), timeout: 15_000, shell: process.platform === 'win32' }, (err, stdout) => {
        if (err) resolve({ ok: false, error: `${basename(bin)} --version failed: ${err.message}` })
        else resolve({ ok: true, version: String(stdout).trim() })
      })
    })
  }

  list(): Task[] {
    return [...this.tasks]
  }

  running(): Task[] {
    return this.tasks.filter((t) => t.status === 'running')
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  /** The most recent job in a folder that left a session behind, for "resume". */
  latestFor(cwd: string): Task | undefined {
    return [...this.tasks].reverse().find((t) => t.cwd === cwd && t.sessionId)
  }

  run(opts: RunOptions): Task {
    const bin = this.findBinary()
    if (!bin) throw new Error('Claude Code is not installed on this computer')
    mkdirSync(this.logDir, { recursive: true })
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const prompt = opts.prompt.trim() || (opts.resume ? 'Continue where you left off and finish the task.' : '')
    const task: Task = {
      id,
      title: opts.title ?? titleFrom(prompt, Boolean(opts.resume)),
      status: 'running',
      cwd: opts.cwd,
      startedAt: Date.now(),
      prompt,
      logPath: join(this.logDir, `${id}.log`)
    }
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', this.permissionMode]
    if (opts.resume === 'last') args.push('--continue')
    else if (opts.resume) args.push('--resume', opts.resume)
    const model = process.env.DESKMATE_CLAUDE_MODEL?.trim()
    if (model) args.push('--model', model)
    const maxTurns = Number(process.env.DESKMATE_CLAUDE_MAX_TURNS)
    if (maxTurns > 0) args.push('--max-turns', String(maxTurns))
    const extra = process.env.DESKMATE_CLAUDE_ARGS?.trim()
    if (extra) args.push(...extra.split(/\s+/))

    this.log(task, `# ${task.title}\n# folder: ${opts.cwd}\n# command: ${basename(bin)} ${args.join(' ')}\n# prompt:\n${prompt}\n`)
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: childEnv(bin),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true
    })
    this.children.set(id, child)
    this.tasks.push(task)
    while (this.tasks.length > MAX_TASKS && this.tasks[0].status !== 'running') this.tasks.shift()
    // The prompt goes in on stdin: no shell quoting on any platform, no length limit to worry about.
    child.stdin.on('error', () => undefined)
    child.stdin.end(prompt + '\n')

    let buffer = ''
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString()
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) this.handleLine(task, line)
      }
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000)
    })
    child.on('error', (err) => this.finish(task, 'failed', err.message))
    child.on('close', (code, signal) => {
      if (buffer.trim()) this.handleLine(task, buffer.trim())
      if (task.status !== 'running') return // cancelled
      if (task.error) this.finish(task, 'failed', task.error)
      else if (code === 0 && task.result !== undefined) this.finish(task, 'done')
      else {
        const lastErr = stderr.trim().split('\n').filter(Boolean).pop()
        this.finish(task, 'failed', (lastErr || `Claude exited with ${code ?? signal}`).slice(0, 300))
      }
    })
    this.emit('start', task)
    return task
  }

  /** Stops a running job (the latest one when no id is given). */
  cancel(id?: string): Task | null {
    const task = id ? this.get(id) : [...this.running()].pop()
    if (!task || task.status !== 'running') return null
    const child = this.children.get(task.id)
    this.finish(task, 'cancelled')
    if (child && !child.killed) {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) child.kill('SIGKILL')
      }, 3000).unref()
    }
    return task
  }

  /** One line per job, newest first, for "how's Claude doing". */
  describe(): string {
    if (!this.tasks.length) return 'No Claude jobs yet.'
    return [...this.tasks]
      .reverse()
      .slice(0, 4)
      .map((t) => {
        const mins = Math.max(1, Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 60_000))
        const where = basename(t.cwd)
        if (t.status === 'running') return `Running: "${t.title}" in ${where}, ${mins} min so far${t.lastTool ? `, currently ${t.lastTool}` : ''}.`
        if (t.status === 'done') return `Done: "${t.title}" in ${where}${t.result ? `. Claude said: ${t.result.slice(0, 240)}` : ''}`
        if (t.status === 'failed') return `Failed: "${t.title}" in ${where}: ${t.error ?? 'unknown error'}`
        return `Stopped: "${t.title}" in ${where}.`
      })
      .join('\n')
  }

  private handleLine(task: Task, line: string): void {
    let ev: StreamEvent
    try {
      ev = JSON.parse(line) as StreamEvent
    } catch {
      this.log(task, line)
      return
    }
    if (ev.session_id && !task.sessionId) task.sessionId = ev.session_id
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          task.lastText = block.text.trim()
          this.log(task, `claude: ${task.lastText}`)
          if (/not logged in/i.test(block.text)) {
            task.error = 'Claude Code is not logged in. Open a terminal, run `claude`, and use /login once.'
          }
        } else if (block.type === 'tool_use' && block.name) {
          task.lastTool = describeTool(block.name, block.input)
          this.log(task, `tool: ${task.lastTool}`)
          this.emit('progress', task)
        }
      }
    } else if (ev.type === 'result') {
      task.result = typeof ev.result === 'string' && ev.result.trim() ? ev.result.trim() : (task.lastText ?? '')
      task.costUsd = ev.total_cost_usd
      task.turns = ev.num_turns
      const errored = ev.is_error || (ev.subtype ?? '').startsWith('error') || /error/i.test(ev.terminal_reason ?? '')
      if (errored && !task.error) task.error = task.result || ev.subtype || 'Claude returned an error'
      this.log(task, `result (${ev.subtype ?? 'unknown'}${ev.terminal_reason ? `, ${ev.terminal_reason}` : ''}): ${task.result}`)
    }
  }

  private finish(task: Task, status: Task['status'], error?: string): void {
    if (task.status !== 'running') return
    task.status = status
    task.endedAt = Date.now()
    if (error) task.error = error
    this.children.delete(task.id)
    this.log(task, `# ${status}${task.error ? `: ${task.error}` : ''} after ${Math.round((task.endedAt - task.startedAt) / 1000)}s${task.costUsd ? ` ($${task.costUsd.toFixed(2)})` : ''}`)
    this.emit('end', task)
  }

  private log(task: Task, text: string): void {
    try {
      appendFileSync(task.logPath, `[${new Date().toISOString()}] ${text}\n`)
    } catch {
      // a full disk is not her problem to solve
    }
  }
}

function titleFrom(prompt: string, resume: boolean): string {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  const short = flat.length > 70 ? `${flat.slice(0, 67).trimEnd()}…` : flat
  return resume ? `continue: ${short || 'last session'}` : short || 'untitled job'
}

function describeTool(name: string, input?: Record<string, unknown>): string {
  const str = (k: string): string | undefined => (typeof input?.[k] === 'string' ? (input[k] as string) : undefined)
  const file = str('file_path') ?? str('path') ?? str('notebook_path')
  if (file) return `${name} ${basename(file)}`
  const cmd = str('command')
  if (cmd) return `${name}: ${cmd.replace(/\s+/g, ' ').slice(0, 60)}`
  const pattern = str('pattern') ?? str('query')
  if (pattern) return `${name} "${pattern.slice(0, 40)}"`
  return name
}

function extraPathDirs(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    return [join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm'), join(home, '.local', 'bin')]
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.claude', 'local'), join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin'), join(home, 'bin')]
}

/** The child's environment: the user's, plus the usual bin folders (apps launched from the Dock get a bare PATH),
 * minus the markers that make Claude Code refuse to start inside another Claude Code session. */
function childEnv(bin: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  delete env.ELECTRON_RUN_AS_NODE
  env.PATH = [dirname(bin), env.PATH ?? '', ...extraPathDirs()].filter(Boolean).join(delimiter)
  return env
}
