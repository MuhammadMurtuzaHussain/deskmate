// "Update available": asks GitHub for the latest release and compares its tag with the running version. Releases are
// unsigned, so this only points at the release page; installing stays a download (no electron-updater / Squirrel).

const LATEST_URL = 'https://api.github.com/repos/MuhammadMurtuzaHussain/deskmate/releases/latest'

export interface Release {
  /** without the leading v, e.g. 0.6.0 */
  version: string
  url: string
}

/** DESKMATE_UPDATE_CHECK=0 turns the check off (it is on by default). */
export function updateCheckEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.DESKMATE_UPDATE_CHECK?.trim() || '')
}

function parse(version: string): { nums: number[]; pre: boolean } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+.*)?$/.exec(version.trim())
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: Boolean(m[4]) } : null
}

/** true when `latest` is a higher semver than `current`; a release beats a prerelease of the same number. */
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i]
  return b.pre && !a.pre
}

/** The latest release when it is newer than `current`; null when up to date, offline, rate-limited or anything odd. */
export async function newerRelease(current: string): Promise<Release | null> {
  try {
    const res = await fetch(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `deskmate/${current}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return null
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }
    if (typeof body.tag_name !== 'string' || body.draft || body.prerelease || !isNewer(body.tag_name, current)) return null
    const page = typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : null
    return {
      version: body.tag_name.replace(/^v/, ''),
      url: page ?? `https://github.com/MuhammadMurtuzaHussain/deskmate/releases/tag/${encodeURIComponent(body.tag_name)}`
    }
  } catch {
    return null
  }
}
