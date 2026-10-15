/** Local brain through Ollama's native API. No key, no quota; screenshots never leave the machine. */

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** base64 images (no data: prefix), only meaningful on vision models */
  images?: string[]
}

export const OLLAMA_URL = (process.env.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434').replace(/\/$/, '')

/** Lists installed model names, or null when no Ollama server answers. */
export async function ollamaModels(): Promise<string[] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    const data = (await res.json()) as { models?: { name: string }[] }
    return (data.models ?? []).map((m) => m.name)
  } catch {
    return null
  }
}

export async function ollamaChat(opts: { model: string; messages: OllamaMessage[]; schema?: Record<string, unknown> }): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // First call after idle loads the model into memory; give it time.
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: false,
      think: false, // honoured by instruct builds; thinking builds ignore it and need a much larger num_predict
      format: opts.schema ?? 'json', // a schema makes small models fill the right fields instead of improvising
      keep_alive: '30m',
      // Small local models drift and loop at high temperature; keep them on a short leash.
      options: { temperature: 0.7, top_p: 0.9, repeat_penalty: 1.15, repeat_last_n: 160, num_ctx: 8192, num_predict: 320 }
    })
  })
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = (await res.json()) as { message?: { content?: string } }
  return data.message?.content ?? ''
}
