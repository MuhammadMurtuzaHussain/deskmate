import { existsSync, readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ExternalTool, ToolImage, ToolOutcome } from './tools.ts'
import { untrusted } from './untrusted.ts'

/**
 * MCP client: the tool servers listed in <user data>/mcp.json (the same shape as Claude Desktop's config,
 * {"mcpServers": {"name": {"command", "args", "env"} | {"url", "headers"}}}) are started or reached, and their tools
 * join her brain's tool list as "<server>__<tool>". Each server can be switched off in Setup. What a server answers is
 * untrusted data in the prompt, and a tool the server does not mark read-only is guarded like a send.
 */

export interface McpServerConfig {
  name: string
  kind: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  /** "disabled": true in the file */
  disabled?: boolean
}

export type McpState = 'off' | 'connecting' | 'ready' | 'error'

export interface McpServerStatus {
  name: string
  kind: 'stdio' | 'http'
  /** the command or the address, for Setup */
  target: string
  enabled: boolean
  state: McpState
  tools: string[]
  error?: string
}

const NAME = /[^a-zA-Z0-9_-]+/g

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map(String) : undefined
}

function record(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]))
}

/** Reads the config object; a bad entry is reported and skipped, the others still load. */
export function parseMcpConfig(raw: unknown): { servers: McpServerConfig[]; errors: string[] } {
  const errors: string[] = []
  const servers: McpServerConfig[] = []
  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const list = root?.mcpServers ?? root?.servers
  if (!list || typeof list !== 'object' || Array.isArray(list)) {
    if (raw !== undefined) errors.push('mcp.json needs an "mcpServers" object')
    return { servers, errors }
  }
  const seen = new Set<string>()
  for (const [rawName, value] of Object.entries(list as Record<string, unknown>)) {
    const name = rawName.replace(NAME, '_').replace(/^_+|_+$/g, '').slice(0, 32)
    if (!name || seen.has(name)) {
      errors.push(`server "${rawName}": the name is empty or used twice`)
      continue
    }
    if (!value || typeof value !== 'object') {
      errors.push(`server "${rawName}": expected an object`)
      continue
    }
    const v = value as Record<string, unknown>
    const disabled = v.disabled === true || v.enabled === false
    if (typeof v.url === 'string' && v.url.trim()) {
      let url: URL
      try {
        url = new URL(v.url.trim())
      } catch {
        errors.push(`server "${rawName}": "${v.url}" is not an address`)
        continue
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        errors.push(`server "${rawName}": only http(s) addresses`)
        continue
      }
      servers.push({ name, kind: 'http', url: url.href, headers: record(v.headers), disabled })
    } else if (typeof v.command === 'string' && v.command.trim()) {
      servers.push({ name, kind: 'stdio', command: v.command.trim(), args: strings(v.args) ?? [], env: record(v.env), cwd: typeof v.cwd === 'string' ? v.cwd : undefined, disabled })
    } else {
      errors.push(`server "${rawName}": needs a "command" or a "url"`)
      continue
    }
    seen.add(name)
  }
  return { servers, errors }
}

/** "<server>__<tool>", made safe for a tool name and kept within 64 characters, unique among `taken`. */
export function namespacedName(server: string, tool: string, taken: Set<string>): string {
  const base = `${server}__${tool.replace(NAME, '_')}`.slice(0, 64)
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 60)}_${n}`
  taken.add(name)
  return name
}

interface CallResult {
  content?: unknown[]
  structuredContent?: unknown
  isError?: boolean
}

/** A tool call's answer as a tool result: its text (wrapped as untrusted) and the first picture, if any. */
export function outcomeFrom(server: string, result: CallResult): ToolOutcome {
  const parts: string[] = []
  let image: ToolImage | undefined
  for (const c of (result.content ?? []) as Record<string, unknown>[]) {
    if (c.type === 'text') parts.push(String(c.text ?? ''))
    else if (c.type === 'image' && !image && (c.mimeType === 'image/png' || c.mimeType === 'image/jpeg')) image = { data: String(c.data), mediaType: c.mimeType }
    else if (c.type === 'resource') {
      const r = (c.resource ?? {}) as Record<string, unknown>
      parts.push(typeof r.text === 'string' ? r.text : `[resource ${String(r.uri ?? '')}]`)
    } else if (c.type === 'resource_link') parts.push(`[link ${String(c.uri ?? '')}${c.name ? ` ${String(c.name)}` : ''}]`)
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent))
  const text = parts.join('\n').trim() || (result.isError ? 'The tool failed without saying why.' : '(no output)')
  return { ok: !result.isError, text: untrusted('mcp', text, server), untrusted: 'mcp', image }
}

/** GUI apps start with a short PATH; npx and uvx usually live in these. */
function fullPath(path: string | undefined): string {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME ?? ''}/.local/bin`, `${process.env.HOME ?? ''}/.cargo/bin`]
  const have = (path ?? '').split(':').filter(Boolean)
  return [...have, ...extra.filter((p) => !have.includes(p))].join(':')
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms)
      timer.unref?.()
    })
  ])
}

interface Connection {
  config: McpServerConfig
  state: McpState
  client?: Client
  tools: { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }[]
  error?: string
}

export interface McpHubOptions {
  configPath: string
  /** the per-server switch from Setup (servers are on unless switched off there or in the file) */
  isEnabled(name: string, config: McpServerConfig): boolean
  /** each tool call, for the journal */
  journal?(text: string): void
  log?(line: string): void
  version?: string
  connectTimeoutMs?: number
  callTimeoutMs?: number
}

export class McpHub {
  private conns = new Map<string, Connection>()
  private errors: string[] = []
  private readonly opts: McpHubOptions

  constructor(opts: McpHubOptions) {
    this.opts = opts
  }

  private log(line: string): void {
    this.opts.log?.(`[mcp] ${line}`)
  }

  /** Reads mcp.json and connects every enabled server (in parallel); safe to call again to reload. */
  async start(): Promise<void> {
    await this.close()
    this.errors = []
    let raw: unknown
    if (existsSync(this.opts.configPath)) {
      try {
        raw = JSON.parse(readFileSync(this.opts.configPath, 'utf8'))
      } catch (err) {
        this.errors.push(`mcp.json is not valid JSON: ${(err as Error).message}`)
      }
    }
    const { servers, errors } = parseMcpConfig(raw)
    this.errors.push(...errors)
    for (const e of errors) this.log(e)
    for (const config of servers) this.conns.set(config.name, { config, state: 'off', tools: [] })
    await Promise.all(servers.filter((c) => this.opts.isEnabled(c.name, c)).map((c) => this.connect(c.name)))
  }

  private transport(config: McpServerConfig, sse = false): Transport {
    if (config.kind === 'http') {
      const url = new URL(config.url as string)
      const requestInit = config.headers ? { headers: config.headers } : undefined
      return sse ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit })
    }
    const env = { ...getDefaultEnvironment(), ...config.env }
    env.PATH = fullPath(config.env?.PATH ?? process.env.PATH)
    const t = new StdioClientTransport({ command: config.command as string, args: config.args, env, cwd: config.cwd, stderr: 'pipe' })
    // A server's own chatter goes to the log, never to the prompt.
    t.stderr?.on('data', (chunk: Buffer) => this.log(`${config.name}: ${chunk.toString().trim().slice(0, 300)}`))
    return t
  }

  private async connect(name: string): Promise<void> {
    const conn = this.conns.get(name)
    if (!conn || conn.state === 'ready' || conn.state === 'connecting') return
    conn.state = 'connecting'
    conn.error = undefined
    const timeout = this.opts.connectTimeoutMs ?? 30_000
    const attempt = async (sse: boolean): Promise<Client> => {
      const client = new Client({ name: 'deskmate', version: this.opts.version ?? '0' })
      await withTimeout(client.connect(this.transport(conn.config, sse)), timeout, `connecting to ${name}`)
      return client
    }
    try {
      let client: Client
      try {
        client = await attempt(false)
      } catch (err) {
        // Older HTTP servers speak the SSE transport only.
        if (conn.config.kind !== 'http') throw err
        this.log(`${name}: streamable HTTP failed (${(err as Error).message}); trying SSE`)
        client = await attempt(true)
      }
      const tools: Connection['tools'] = []
      let cursor: string | undefined
      do {
        const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), timeout, `listing ${name}'s tools`)
        for (const t of page.tools) {
          tools.push({
            name: t.name,
            description: (t.description ?? t.title ?? t.name).slice(0, 900),
            inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
            readOnly: t.annotations?.readOnlyHint === true
          })
        }
        cursor = page.nextCursor
      } while (cursor && tools.length < 200)
      client.onclose = () => {
        const c = this.conns.get(name)
        if (c && c.client === client && c.state === 'ready') {
          c.state = 'error'
          c.error = 'the server closed the connection'
          c.client = undefined
          this.log(`${name}: closed`)
        }
      }
      conn.client = client
      conn.tools = tools
      conn.state = 'ready'
      this.log(`${name}: ready with ${tools.length} tool(s)`)
    } catch (err) {
      conn.state = 'error'
      conn.error = (err as Error).message.slice(0, 300)
      conn.client = undefined
      this.log(`${name}: ${conn.error}`)
    }
  }

  private async disconnect(name: string): Promise<void> {
    const conn = this.conns.get(name)
    if (!conn) return
    const client = conn.client
    conn.client = undefined
    conn.state = 'off'
    conn.tools = []
    await client?.close().catch(() => undefined)
  }

  /** Setup's switch: connects or closes the server now (the caller saves the choice). */
  async setEnabled(name: string, on: boolean): Promise<void> {
    if (on) await this.connect(name)
    else await this.disconnect(name)
  }

  /** The tools of every ready server, in a fixed order so the prompt prefix stays cacheable. */
  tools(): ExternalTool[] {
    const taken = new Set<string>()
    const out: ExternalTool[] = []
    for (const conn of [...this.conns.values()].sort((a, b) => a.config.name.localeCompare(b.config.name))) {
      if (conn.state !== 'ready' || !conn.client) continue
      for (const t of [...conn.tools].sort((a, b) => a.name.localeCompare(b.name))) {
        const server = conn.config.name
        out.push({
          name: namespacedName(server, t.name, taken),
          server,
          tool: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          readOnly: t.readOnly,
          call: (args) => this.call(server, t.name, args)
        })
      }
    }
    return out
  }

  async call(server: string, tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const conn = this.conns.get(server)
    if (!conn?.client || conn.state !== 'ready') return { ok: false, text: `The ${server} tool server is not connected.` }
    const brief = JSON.stringify(args).slice(0, 160)
    try {
      const result = (await conn.client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.opts.callTimeoutMs ?? 120_000 })) as CallResult
      const out = outcomeFrom(server, result)
      this.opts.journal?.(`${server}.${tool} ${brief} → ${out.ok ? 'ok' : 'error'}`)
      return out
    } catch (err) {
      const message = (err as Error).message.slice(0, 300)
      this.opts.journal?.(`${server}.${tool} ${brief} → failed: ${message}`)
      return { ok: false, text: `${server}.${tool} failed: ${message}` }
    }
  }

  status(): McpServerStatus[] {
    return [...this.conns.values()].map((c) => ({
      name: c.config.name,
      kind: c.config.kind,
      target: c.config.kind === 'http' ? (c.config.url as string) : [c.config.command, ...(c.config.args ?? [])].join(' '),
      enabled: this.opts.isEnabled(c.config.name, c.config),
      state: c.state,
      tools: c.tools.map((t) => t.name),
      ...(c.error ? { error: c.error } : {})
    }))
  }

  configErrors(): string[] {
    return [...this.errors]
  }

  async close(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((n) => this.disconnect(n)))
    this.conns.clear()
  }
}
