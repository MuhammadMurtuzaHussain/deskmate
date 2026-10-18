// Optional code beside skill.json. This one only tidies the note before it is typed: "make a note saying buy milk in
// notes" becomes "Buy milk". It has no run(), so the steps in skill.json still do the work.

/** @param {Record<string, string>} slots */
export function slots(slots) {
  const text = slots.text.replace(/\s+(?:in|to|into) (?:apple )?notes$/i, '').trim()
  if (!text) return null
  return { ...slots, text: text[0].toUpperCase() + text.slice(1) }
}
