// "Update available": asks GitHub for the newest release and compares its tag with the running version. This is the
// fallback when the app cannot install updates itself (updater.ts: unsigned Mac builds, the portable Windows exe, a
// .deb, a checkout), so it only points at the release page.

const REPO_API = 'https://api.github.com/repos/MuhammadMurtuzaHussain/deskmate'

export interface Release {
  /** without the leading v, e.g. 0.6.0 */
  version: string
  url: string
}

/** DESKMATE_UPDATE_CHECK=0 turns the check off (it is on by default). */
export function updateCheckEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.DESKMATE_UPDATE_CHECK?.trim() || '')
}

interface Parsed {
  nums: number[]
  /** the prerelease identifiers, e.g. ['rc', 1]; empty for a release */
  pre: (string | number)[]
}

function parse(version: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(\+.*)?$/.exec(version.trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [] }
}

/** true when `version` has a prerelease part (1.0.0-rc.1) */
export function isPrerelease(version: string): boolean {
  return Boolean(parse(version)?.pre.length)
}

/** true when `latest` is a higher semver than `current`: a release beats its prereleases, rc.2 beats rc.1. */
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i]
  if (!a.pre.length || !b.pre.length) return b.pre.length > 0 && !a.pre.length
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return false
    if (y === undefined) return true
    if (x === y) continue
    // numbers sort before words, numbers by value, words by ASCII (semver §11)
    if (typeof x === 'number' && typeof y === 'number') return x > y
    if (typeof x === 'number') return false
    if (typeof y === 'number') return true
    return x > y
  }
  return false
}

interface GitHubRelease {
  tag_name?: unknown
  html_url?: unknown
  draft?: unknown
  prerelease?: unknown
}

function toRelease(body: GitHubRelease): Release | null {
  if (typeof body.tag_name !== 'string') return null
  const page = typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : null
  return {
    version: body.tag_name.replace(/^v/, ''),
    url: page ?? `https://github.com/MuhammadMurtuzaHussain/deskmate/releases/tag/${encodeURIComponent(body.tag_name)}`
  }
}

/**
 * The newest release when it is newer than `current`; null when up to date, offline, rate-limited or anything odd.
 * A release build only looks at releases; a prerelease (1.0.0-rc.1) also sees newer prereleases, so testers move on
 * from rc.1 to rc.2 and then to 1.0.0.
 */
export async function newerRelease(current: string): Promise<Release | null> {
  const pre = isPrerelease(current)
  try {
    const res = await fetch(pre ? `${REPO_API}/releases?per_page=20` : `${REPO_API}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `deskmate/${current}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return null
    const body = (await res.json()) as GitHubRelease | GitHubRelease[]
    const list = (Array.isArray(body) ? body : [body]).filter((r) => typeof r.tag_name === 'string' && !r.draft && (pre || !r.prerelease))
    let best: GitHubRelease | null = null
    for (const r of list) if (isNewer(r.tag_name as string, best ? (best.tag_name as string) : current)) best = r
    return best ? toRelease(best) : null
  } catch {
    return null
  }
}
