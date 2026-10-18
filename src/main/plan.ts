import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plan, PlanStep, PlanWorker } from '../shared/types'

/**
 * "She plans it out": a bigger goal becomes a short list of steps, each handed to the worker that is good at it, shown
 * on a card and read out in a line; nothing runs until a go. While it runs, each step's result goes to the next, a
 * failed step pauses the plan, and "skip step 2", "change step 3 to …", "pause", "stop the plan" work by voice.
 */

export const WORKERS: PlanWorker[] = ['computer', 'browse', 'claude', 'app', 'find', 'open', 'say', 'ask']

const WORKER_HELP: Record<PlanWorker, string> = {
  computer: 'work any app on this Mac step by step (open apps, click, type, read windows): Notes, Finder, Mail, WhatsApp, Settings-free tasks',
  browse: 'look something up or get something done in their Chrome browser',
  claude: 'a coding or file job for Claude Code in a project folder (write or fix code, edit files, run scripts); set "dir" to the folder they named',
  app: 'one quick action: a Discord, Slack or Messages message ("Discord: tell sam I am late"), Spotify play / pause / skip, or a prompt to the Claude app',
  find: 'find a file or folder on this Mac by name and show it',
  open: 'open an app, a folder or a website by name',
  say: 'tell them something at the end: a summary of what the earlier steps found or did',
  ask: 'ask them a yes/no question before going on (only when a real decision is needed)'
}

export function plannerSystem(workers: PlanWorker[]): string {
  return `You plan a job on the user's Mac for their desk companion, who then does it one step at a time.
Workers she can hand a step to:
${workers.map((w) => `- "${w}": ${WORKER_HELP[w]}`).join('\n')}

Reply with ONE JSON object: {"title": string, "steps": [{"text": string, "worker": string, "input": string, "dir": string|null}]}
- "title": the goal in four to seven words.
- 2 to 8 steps, in order. Each step is one worker's job; do not split one app's work into many tiny steps.
- "text": what the step does, short and plain (at most eight words), shown on a card.
- "input": the instruction that worker gets, self-contained: names, file names, and the exact words to send exactly as they said them. Later steps may say "from the earlier steps" when they need a result.
- "dir": the project folder for "claude" steps when they named one, else null.
- Only what they asked for. When the goal is to find something out, end with a "say" step that tells them. No purchases, payments or deleting unless they asked; messages are fine (they are read back before sending).`
}

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          worker: { type: 'string', enum: WORKERS },
          input: { type: 'string' },
          dir: { type: ['string', 'null'] }
        },
        required: ['text', 'worker', 'input', 'dir']
      }
    }
  },
  required: ['title', 'steps']
}

export function reviseSystem(workers: PlanWorker[]): string {
  return `${plannerSystem(workers)}

You are revising an existing plan: you get the plan as JSON and the change they asked for. Return the whole revised plan in the same shape; keep the steps they did not mention as they are.`
}

/** A planner reply made into a plan, with workers checked against what is available. */
export function toPlan(goal: string, obj: Record<string, unknown>, workers: PlanWorker[], id = newId()): Plan | null {
  const raw = Array.isArray(obj.steps) ? (obj.steps as Record<string, unknown>[]) : []
  const steps: PlanStep[] = raw
    .map((s) => ({
      text: String(s.text ?? '').trim().slice(0, 80),
      worker: (workers.includes(s.worker as PlanWorker) ? s.worker : workers.includes('computer') ? 'computer' : 'browse') as PlanWorker,
      input: String(s.input ?? s.text ?? '').trim(),
      dir: s.dir ? String(s.dir) : null,
      status: 'pending' as const
    }))
    .filter((s) => s.text && s.input)
    .slice(0, 8)
  if (!steps.length) return null
  return { id, goal, title: String(obj.title ?? goal).trim().slice(0, 60) || goal.slice(0, 60), steps, status: 'draft', current: 0, createdAt: Date.now() }
}

function newId(): string {
  return `plan-${Date.now().toString(36)}`
}

/** "1", "two", "first", "last" → a step index, or null. */
function stepIndex(word: string, plan: Plan): number | null {
  const w = word.toLowerCase()
  const ordinals: Record<string, number> = { first: 1, one: 1, second: 2, two: 2, third: 3, three: 3, fourth: 4, four: 4, fifth: 5, five: 5, sixth: 6, six: 6, seventh: 7, seven: 7, eighth: 8, eight: 8 }
  if (/^(?:last|final)$/.test(w)) return plan.steps.length - 1
  if (/^(?:that|this|it|that one|this one|the current one)$/.test(w)) return plan.current
  const n = /^\d+$/.test(w) ? Number(w) : ordinals[w]
  return n && n >= 1 && n <= plan.steps.length ? n - 1 : null
}

export type PlanCommand =
  | { kind: 'go' | 'pause' | 'resume' | 'stop' | 'retry' }
  | { kind: 'skip'; index: number }
  | { kind: 'revise'; instruction: string }

/** What they said about the plan on screen, if anything; null means it was not about the plan. */
export function planCommand(text: string, plan: Plan): PlanCommand | null {
  const t = text.toLowerCase().replace(/[.!?]+$/g, '').replace(/^(?:ok(?:ay)?|alright|right|hmm)[, ]+/, '').trim()
  const waiting = plan.status === 'draft' || plan.status === 'paused'
  if (/^(?:stop|cancel|abort|scrap|drop|forget)(?: (?:the|this|that))? plan$/.test(t) || (waiting && /^(?:cancel|never ?mind|forget it|no)$/.test(t))) return { kind: 'stop' }
  if (plan.status === 'running' && /^(?:pause|hold on|hold up|wait)(?: (?:the|this) plan)?$/.test(t)) return { kind: 'pause' }
  if (plan.status === 'paused' && /^(?:resume|continue|carry on|keep going|go on|go|go ahead|yes)(?: (?:the|this) plan)?$/.test(t)) return { kind: 'resume' }
  if (plan.status === 'paused' && /^(?:retry|try again|try that again|again)(?: (?:that|the|this) step)?$/.test(t)) return { kind: 'retry' }
  if (plan.status === 'draft' && /^(?:go|go ahead|yes|yep|yeah|sure|start|do it|run it|sounds good|looks good|perfect|let'?s (?:go|do it)|start the plan)$/.test(t)) return { kind: 'go' }
  const skip = /^(?:skip|drop|remove|delete|leave out|no need for)(?: the)? (?:step )?(\w+)(?: step| one)?$/.exec(t)
  if (skip) {
    const index = stepIndex(skip[1], plan)
    if (index !== null) return { kind: 'skip', index }
  }
  if (waiting && /^(?:change|make|replace|edit|instead|add|also|and then|then|before that|after that|move|swap|put|use|don'?t|do not|step \w+ (?:should|to))\b/.test(t)) return { kind: 'revise', instruction: text }
  return null
}

/** Plans are kept in <user data>/plans, the last one also as current.json, so a restart can show what was going on. */
export class PlanStore {
  constructor(private readonly dir: string) {}

  save(plan: Plan): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(join(this.dir, `${plan.id}.json`), JSON.stringify(plan, null, 2))
    } catch (err) {
      console.warn('[plan] could not save:', (err as Error).message)
    }
  }

  load(id: string): Plan | null {
    const p = join(this.dir, `${id}.json`)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as Plan
    } catch {
      return null
    }
  }
}

/** One line for her to say about a plan: the title and the steps, short. */
export function planSummary(plan: Plan): string {
  const steps = plan.steps.filter((s) => s.status !== 'skipped')
  const list = steps.map((s, i) => `${i + 1}, ${s.text.replace(/[.]+$/, '').toLowerCase()}`).join('; ')
  return `Here's the plan, ${steps.length} step${steps.length === 1 ? '' : 's'}: ${list}. Say go, or tell me what to change.`
}
