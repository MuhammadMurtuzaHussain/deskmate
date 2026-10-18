import type { ActivityRow, ActivityView } from '../shared/types'

// The Activity window: today's tool calls, newest first, with Undo where it is honest.
const api = window.deskmate
const rowsEl = document.getElementById('rows') as HTMLOListElement
const all = document.getElementById('all') as HTMLInputElement
let view: ActivityView | null = null

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

function row(r: ActivityRow): HTMLLIElement {
  const refused = /said no|switched off|waiting/.test(r.approval)
  const li = el('li', [r.undone ? 'undone' : '', refused ? 'refused' : !r.ok ? 'failed' : '', r.looking ? 'looking' : ''].filter(Boolean).join(' '))
  li.append(el('span', 'time', new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))
  const what = el('div', 'what')
  what.append(el('div', 'tool', r.tool))
  if (r.detail) what.append(el('div', 'detail', r.detail))
  what.title = r.result
  li.append(what)
  const act = el('div', 'act')
  if (r.undo) {
    const b = el('button', '', 'Undo')
    b.title = r.undo
    b.addEventListener('click', async () => {
      b.disabled = true
      const res = await api.activityUndo?.(r.id)
      b.textContent = res?.ok ? 'Undone' : 'Could not'
      b.title = res?.text ?? ''
    })
    act.append(b)
  } else if (r.undone) act.append(el('span', 'no', 'undone'))
  else if (r.noUndo) act.append(el('span', 'no', "can't undo"))
  if (r.noUndo) act.title = r.noUndo
  li.append(act)
  const status = r.undone ? 'undone' : refused ? r.approval : r.ok ? `done ${r.approval}` : 'failed'
  li.append(el('div', 'meta', `${r.origin} · ${status}${r.undo ? ` · undo would ${r.undo}` : r.noUndo ? ` · ${r.noUndo}` : ''}`))
  if (r.why) li.append(el('div', 'why', `for: ${r.why}`))
  return li
}

function render(): void {
  if (!view) return
  ;(document.getElementById('day') as HTMLElement).textContent = view.day
  ;(document.getElementById('spend') as HTMLElement).textContent = view.spend
  document.getElementById('halted')?.classList.toggle('hidden', !view.halted)
  const shown = view.rows.filter((r) => all.checked || !r.looking)
  rowsEl.replaceChildren(...shown.map(row))
  document.getElementById('empty')?.classList.toggle('hidden', shown.length > 0)
}

all.addEventListener('change', render)
api.onActivity?.((v) => {
  view = v
  render()
})
