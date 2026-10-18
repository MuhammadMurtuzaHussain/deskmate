/** Minimal Google AI Studio (Gemini) client over REST; no SDK so the dependency list stays small. */

export type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } }
export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: GeminiUsage
}

export interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
}

/** The spending meter (spend.ts): before() may refuse a call when the budget is used up; after() counts it. */
export interface GeminiMeter {
  before?(model: string): Promise<void>
  after?(model: string, usage: GeminiUsage | undefined): void
}
let meter: GeminiMeter | null = null
export function setGeminiMeter(m: GeminiMeter | null): void {
  meter = m
}

export class GeminiBlockedError extends Error {}
/** 429 with a quota message: retrying will not help until the quota window resets. */
export class GeminiQuotaError extends Error {}

export async function geminiGenerate(opts: {
  apiKey: string
  model: string
  system: string
  contents: GeminiContent[]
}): Promise<string> {
  // One retry on overload / rate limit; the companion should not sulk over a transient 503.
  try {
    return await geminiOnce(opts)
  } catch (err) {
    if (err instanceof Error && (/HTTP (503|429|500)/.test(err.message) || err.name === 'TimeoutError')) {
      await new Promise((r) => setTimeout(r, 1500))
      return geminiOnce(opts)
    }
    throw err
  }
}

async function geminiOnce(opts: { apiKey: string; model: string; system: string; contents: GeminiContent[] }): Promise<string> {
  await meter?.before?.(opts.model)
  const generationConfig: Record<string, unknown> = {
    temperature: 0.9,
    maxOutputTokens: 1024,
    responseMimeType: 'application/json'
  }
  // 2.5 Flash thinks by default; a companion wants the fast path.
  if (/2\.5-flash/.test(opts.model)) generationConfig.thinkingConfig = { thinkingBudget: 0 }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        system_instruction: { parts: [{ text: opts.system }] },
        contents: opts.contents,
        generationConfig,
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
        ]
      })
    }
  )
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    if (res.status === 429 && /quota/i.test(body)) throw new GeminiQuotaError(`Gemini quota exhausted for ${opts.model}`)
    throw new Error(`Gemini HTTP ${res.status}: ${body}`)
  }
  const data = (await res.json()) as GeminiResponse
  try {
    meter?.after?.(opts.model, data.usageMetadata)
  } catch (err) {
    console.warn('[spend]', (err as Error).message)
  }
  if (data.promptFeedback?.blockReason) throw new GeminiBlockedError(data.promptFeedback.blockReason)
  const candidate = data.candidates?.[0]
  if (!candidate) throw new GeminiBlockedError('no candidates')
  if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'PROHIBITED_CONTENT') {
    throw new GeminiBlockedError(candidate.finishReason)
  }
  return (candidate.content?.parts ?? []).map((p) => p.text ?? '').join('')
}

/** Cheap key check: list models. Returns a user-facing error when the key is rejected. */
export async function geminiCheckKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(15_000)
    })
    if (res.ok) return { ok: true }
    if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, error: 'Google rejected that key' }
    return { ok: false, error: `Google answered HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, error: `could not reach Google: ${(err as Error).message}` }
  }
}
