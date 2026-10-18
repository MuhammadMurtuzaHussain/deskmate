// Update check against a stubbed fetch: no network. Run with `npm test`.
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { isNewer, newerRelease, updateCheckEnabled } from '../src/main/updates.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.DESKMATE_UPDATE_CHECK
})

function answer(status: number, body: unknown): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
}

test('semver compare', () => {
  assert.equal(isNewer('v0.6.0', '0.5.0'), true)
  assert.equal(isNewer('0.5.1', '0.5.0'), true)
  assert.equal(isNewer('1.0.0', '0.9.9'), true)
  assert.equal(isNewer('v0.5.0', '0.5.0'), false)
  assert.equal(isNewer('0.4.9', '0.5.0'), false)
  assert.equal(isNewer('0.10.0', '0.9.0'), true)
  assert.equal(isNewer('0.6.0', '0.6.0-beta.1'), true)
  assert.equal(isNewer('0.6.0-beta.1', '0.6.0'), false)
  assert.equal(isNewer('nightly', '0.5.0'), false)
})

test('a newer release comes back with its page; same, older, drafts and prereleases do not', async () => {
  answer(200, { tag_name: 'v0.7.0', html_url: 'https://github.com/MuhammadMurtuzaHussain/deskmate/releases/tag/v0.7.0' })
  assert.deepEqual(await newerRelease('0.6.0'), { version: '0.7.0', url: 'https://github.com/MuhammadMurtuzaHussain/deskmate/releases/tag/v0.7.0' })
  answer(200, { tag_name: 'v0.6.0', html_url: 'https://github.com/x' })
  assert.equal(await newerRelease('0.6.0'), null)
  answer(200, { tag_name: 'v0.7.0', prerelease: true })
  assert.equal(await newerRelease('0.6.0'), null)
  answer(200, { tag_name: 'v0.7.0', draft: true })
  assert.equal(await newerRelease('0.6.0'), null)
})

test('a page outside github.com is not trusted; errors and rate limits are quiet', async () => {
  answer(200, { tag_name: 'v0.7.0', html_url: 'https://evil.example/download' })
  assert.equal((await newerRelease('0.6.0'))?.url, 'https://github.com/MuhammadMurtuzaHussain/deskmate/releases/tag/v0.7.0')
  answer(403, { message: 'API rate limit exceeded' })
  assert.equal(await newerRelease('0.6.0'), null)
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  assert.equal(await newerRelease('0.6.0'), null)
})

test('DESKMATE_UPDATE_CHECK turns it off', () => {
  assert.equal(updateCheckEnabled(), true)
  for (const off of ['0', 'false', 'no', 'OFF']) {
    process.env.DESKMATE_UPDATE_CHECK = off
    assert.equal(updateCheckEnabled(), false)
  }
  process.env.DESKMATE_UPDATE_CHECK = '1'
  assert.equal(updateCheckEnabled(), true)
})
