import Anthropic from '@anthropic-ai/sdk'

/**
 * Claude through the Anthropic API: her brain when you pick it in the setup window (your own API key). Chat replies
 * use structured output with the same JSON contract as the other brains; the computer agent uses tool use.
 */

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'

export type ClaudeEffort = 'low' | 'medium' | 'high'
export const CLAUDE_EFFORTS: ClaudeEffort[] = ['low', 'medium', 'high']

/** Models that take the server-side refusal fallback (`fallbacks: "default"`): a declined request is re-run on the
 * model Anthropic recommends for that category instead of coming back empty. */
const SERVER_FALLBACK = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

/** Older models reject `output_config.effort`; everything from the 4.6 generation on takes it. */
function takesEffort(model: string): boolean {
  return !/claude-(?:3|haiku-4|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0)/.test(model)
}

export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly code: 'auth' | 'rate' | 'overloaded' | 'refusal' | 'bad_request' | 'network' | 'other'
  ) {
    super(message)
  }
}

export function claudeClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 })
}

export interface ClaudeCall {
  model: string
  system: Anthropic.Beta.BetaTextBlockParam[]
  messages: Anthropic.Beta.BetaMessageParam[]
  tools?: Anthropic.Beta.BetaToolUnion[]
  /** JSON schema for the reply (structured output); omit for tool use */
  schema?: Record<string, unknown>
  effort?: ClaudeEffort
  maxTokens?: number
}

/** One Messages API call with her defaults; typed failures become ClaudeError. */
export async function callClaude(client: Anthropic, call: ClaudeCall): Promise<Anthropic.Beta.BetaMessage> {
  const outputConfig: Anthropic.Beta.BetaOutputConfig = {}
  if (call.effort && takesEffort(call.model)) outputConfig.effort = call.effort
  if (call.schema) outputConfig.format = { type: 'json_schema', schema: call.schema }
  const fallback = SERVER_FALLBACK.has(call.model)
  let res: Anthropic.Beta.BetaMessage
  try {
    res = await client.beta.messages.create({
      model: call.model,
      max_tokens: call.maxTokens ?? 16000,
      system: call.system,
      messages: call.messages,
      ...(call.tools ? { tools: call.tools } : {}),
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
    })
  } catch (err) {
    throw toClaudeError(err)
  }
  if (res.stop_reason === 'refusal') {
    throw new ClaudeError(`Claude declined this request${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}`, 'refusal')
  }
  return res
}

export function toClaudeError(err: unknown): ClaudeError {
  if (err instanceof ClaudeError) return err
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new ClaudeError('the Anthropic key was not accepted', 'auth')
  if (err instanceof Anthropic.RateLimitError) return new ClaudeError('Anthropic rate limit reached', 'rate')
  if (err instanceof Anthropic.NotFoundError) return new ClaudeError(`model not found: ${err.message}`, 'bad_request')
  if (err instanceof Anthropic.BadRequestError) return new ClaudeError(err.message, 'bad_request')
  if (err instanceof Anthropic.InternalServerError) return new ClaudeError('Anthropic is overloaded right now', 'overloaded')
  if (err instanceof Anthropic.APIConnectionError) return new ClaudeError('could not reach Anthropic (offline?)', 'network')
  if (err instanceof Anthropic.APIError) return new ClaudeError(`Anthropic error ${err.status}: ${err.message}`, 'other')
  return new ClaudeError((err as Error).message ?? String(err), 'other')
}

/** The text of a reply (structured output arrives as one text block). */
export function replyText(res: Anthropic.Beta.BetaMessage): string {
  return res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

export interface ClaudeModelInfo {
  id: string
  name: string
}

/** The models this key can use, newest first; also how a key is checked. */
export async function listClaudeModels(apiKey: string): Promise<ClaudeModelInfo[]> {
  const client = claudeClient(apiKey)
  const out: ClaudeModelInfo[] = []
  try {
    for await (const m of client.models.list({ limit: 100 })) out.push({ id: m.id, name: m.display_name })
  } catch (err) {
    throw toClaudeError(err)
  }
  return out
}
