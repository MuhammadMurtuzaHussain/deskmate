// The plan card: the steps of what she is about to do or doing, ticking off, with Go / Pause / Stop.
import type { Plan, PlanAction, PlanStep } from '../shared/types'

const api = window.deskmate
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

const WORKER_LABEL: Record<PlanStep['worker'], string> = {
  computer: 'on the Mac',
  browse: 'Chrome',
  claude: 'Claude Code',
  app: 'app',
  find: 'Finder',
  open: 'open',
  say: 'tell you',
  ask: 'ask you'
}
const STATE_LABEL: Record<Plan['status'], string> = { draft: 'waiting for your go', running: 'working', paused: 'paused', done: 'done', stopped: 'stopped' }

function button(label: string, action: PlanAction, primary = false): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  if (primary) b.className = 'primary'
  b.addEventListener('click', () => api.planAction?.(action))
  return b
}

function render(plan: Plan | null): void {
  if (!plan) return
  $('title').textContent = plan.title
  const state = $('state')
  state.textContent = STATE_LABEL[plan.status]
  state.className = `chip ${plan.status}`
  const list = $('steps')
  list.innerHTML = ''
  plan.steps.forEach((s, i) => {
    const li = document.createElement('li')
    li.className = s.status
    const icon = document.createElement('span')
    icon.className = 'icon'
    icon.textContent = s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : s.status === 'pending' ? String(i + 1) : ''
    const text = document.createElement('span')
    text.className = 'text'
    text.textContent = s.text
    const worker = document.createElement('span')
    worker.className = 'worker'
    worker.textContent = `· ${WORKER_LABEL[s.worker]}`
    text.appendChild(worker)
    li.append(icon, text)
    if (s.result && (s.status === 'done' || s.status === 'failed')) {
      const r = document.createElement('span')
      r.className = 'result'
      r.textContent = s.result
      li.appendChild(r)
    }
    list.appendChild(li)
  })
  $('note').textContent = plan.status === 'paused' || plan.status === 'stopped' ? (plan.note ?? '') : ''
  const buttons = $('buttons')
  buttons.innerHTML = ''
  if (plan.status === 'draft') buttons.append(button('Go', 'go', true), button('Cancel', 'stop'))
  else if (plan.status === 'running') buttons.append(button('Pause', 'pause'), button('Stop', 'stop'))
  else if (plan.status === 'paused') buttons.append(button('Resume', 'resume', true), button('Retry step', 'retry'), button('Stop', 'stop'))
  else buttons.append(button('Close', 'dismiss'))
  $('hint').textContent =
    plan.status === 'draft' ? 'Say "go", "skip step 2" or "change step 3 to …"' : plan.status === 'running' ? 'Say "pause" or "stop the plan"' : ''
  // The window fits the card.
  requestAnimationFrame(() => api.planHeight?.(document.getElementById('card')!.getBoundingClientRect().height + 14))
}

api.onPlan?.(render)
