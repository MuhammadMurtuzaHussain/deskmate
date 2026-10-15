/**
 * Her name as a wake word. Whisper spells a name the way it sounds ("Mika" comes back as Mika, Mica, Meeka, Mikah),
 * so the match folds both sides to a rough phonetic form first, and allows a letter or two of slack on longer names.
 * Only the vocative positions count: her name at the start of the sentence (after a "hey" or an "ok") or at its end.
 * "I told Mika yesterday" is about her, not to her.
 */

export interface WakeHit {
  /** the word(s) Whisper wrote for her name, as written ("Mica,") */
  heard: string
  /** the sentence without her name and without the greeting in front of it */
  rest: string
}

export interface WakeMatcher {
  /** her name at the start or the end of the sentence, or null */
  find(text: string): WakeHit | null
  /** true when, with the name gone, nothing is really left: "Mika?", "hey Mika", "Mika, you there?" */
  alone(rest: string): boolean
}

const FILLER = /^(?:hey|hi|hello|hiya|yo|ok|okay|so|um|uh|hmm|oh|ah|please|and|excuse me)$/i
const ALONE =
  /^(?:(?:are )?you (?:there|here|listening|awake|around|up|with me)|can you hear me|hello|hi|hey|wake up|listen|are you there|you there)$/i

export function createWakeMatcher(name: string): WakeMatcher {
  const target = tokens(name).map(fold).filter(Boolean)
  const n = Math.max(1, target.length)
  const folded = target.join('')
  // Short names get no slack: "Mike" must not wake "Mika". Longer ones survive a letter being off.
  const slack = folded.length >= 9 ? 2 : folded.length >= 6 ? 1 : 0

  function matches(words: string[], allow: number): boolean {
    const candidate = words.join('')
    return candidate === folded || (allow > 0 && Math.abs(candidate.length - folded.length) <= allow && levenshtein(candidate, folded) <= allow)
  }

  return {
    find(text: string): WakeHit | null {
      const words = tokens(text)
      if (!words.length || !target.length) return null
      const foldedWords = words.map(fold)
      // Her name on its own gives Whisper nothing to go on ("Mico", "Amika"): a bare one or two words get a letter of slack.
      const allow = words.length <= n + 1 ? Math.max(slack, 1) : slack
      for (let i = 0; i + n <= words.length; i++) {
        const atStart = words.slice(0, i).every((w) => FILLER.test(bare(w)))
        const after = words.slice(i + n)
        const atEnd = after.length === 0 || (after.length === 1 && FILLER.test(bare(after[0])))
        if (!atStart && !atEnd) continue
        if (!matches(foldedWords.slice(i, i + n), allow)) continue
        const heard = words.slice(i, i + n).join(' ')
        // The greeting that led up to her name goes with it: "hey Mika" is her name alone.
        const before = atStart ? [] : words.slice(0, i)
        const rest = [...before, ...after].join(' ').replace(/^[\s,.;:!?-]+/, '').trim()
        return { heard, rest }
      }
      return null
    },

    alone(rest: string): boolean {
      const words = tokens(rest).map(bare).filter(Boolean)
      if (!words.length) return true
      const sentence = words.join(' ')
      return ALONE.test(sentence) || words.every((w) => FILLER.test(w))
    }
  }
}

function tokens(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}

/** lower case letters, digits and apostrophes only */
function bare(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
}

/** A rough phonetic key: letters only, hard c → k, ph → f, long e / y → i, doubled letters and a silent final h gone. */
export function fold(word: string): string {
  return word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '')
    .replace(/ck/g, 'k')
    .replace(/c(?!h)/g, 'k')
    .replace(/ph/g, 'f')
    .replace(/ee|ea|ie|ei|ey|y/g, 'i')
    .replace(/(.)\1+/g, '$1')
    .replace(/h$/, '')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}
