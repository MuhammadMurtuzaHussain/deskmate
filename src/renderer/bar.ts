// The command bar: type what you want, Enter. Lines she says while it is open show underneath; when she asks
// something (a read-back before sending), the bar stays so you can answer "yes" right there.
const api = window.deskmate
const form = document.getElementById('bar') as HTMLFormElement
const input = document.getElementById('cmd') as HTMLInputElement
const line = document.getElementById('line') as HTMLDivElement

let hideTimer: number | undefined
let waitingOnYes = false

function show(text: string, kind: 'say' | 'status'): void {
  line.textContent = text
  line.title = text
  line.classList.remove('empty')
  line.classList.toggle('status', kind === 'status')
}

/** After her answer, close on our own unless she asked a question or they started typing again. */
function closeSoon(ms: number): void {
  window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => {
    if (!input.value && !waitingOnYes) api.hideBar?.()
  }, ms)
}

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  waitingOnYes = false
  window.clearTimeout(hideTimer)
  document.body.classList.add('busy')
  show('…', 'status')
  api
    .send(text)
    .catch((err: Error) => show(`error: ${err.message}`, 'status'))
    .finally(() => {
      document.body.classList.remove('busy')
      closeSoon(4000)
    })
})

api.onLine?.((say) => {
  show(say, 'say')
  waitingOnYes = /\?\s*$/.test(say)
  if (!waitingOnYes) closeSoon(4500)
})
api.onStatus((text) => {
  if (document.body.classList.contains('busy')) show(text, 'status')
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    api.hideBar?.()
  }
})
// Each time it opens: a clean field with the caret in it.
window.addEventListener('focus', () => {
  input.focus()
  input.select()
  if (!document.body.classList.contains('busy') && !waitingOnYes) line.classList.add('empty')
})
input.focus()
