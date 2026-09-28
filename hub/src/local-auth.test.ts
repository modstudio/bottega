import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_HOME_ENV } from '../../shared/state-directory.ts'
import {
  deadlineIsLive,
  isLoginToken,
  LOCAL_LOGIN_MESSAGE,
  LocalHubAuth,
  readClaimedLoginToken,
  sessionIsAdmitted,
} from './local-auth.ts'

const tokenId = 'a'.repeat(64)
const sessionId = 'b'.repeat(64)

test('a login token is private, single-use, and creates a strict memory session', async () => {
  const state = mkdtempSync(join(tmpdir(), 'hub-login-'))
  let now = 1_000
  const ids = [tokenId, sessionId]
  const auth = new LocalHubAuth(
    { [STATE_HOME_ENV]: state },
    () => now,
    () => ids.shift()!,
  )
  try {
    const loginUrl = auth.mintLoginUrl(7778)
    const directory = join(state, 'hub', 'login-tokens')
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(readdirSync(directory)).toEqual([tokenId])
    expect(statSync(join(directory, tokenId)).mode & 0o777).toBe(0o600)

    const response = auth.exchange(new Request(loginUrl))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('http://127.0.0.1:7778/')
    const cookie = response.headers.get('set-cookie')!
    expect(cookie).toContain(`${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=`)
    expect(auth.allows(new Request('http://127.0.0.1:7778/trpc/x', { headers: { cookie } }))).toBe(
      true,
    )

    now += 12 * 60 * 60 * 1000 + 1
    expect(auth.allows(new Request('http://127.0.0.1:7778/trpc/x', { headers: { cookie } }))).toBe(
      false,
    )

    const replay = auth.exchange(new Request(loginUrl))
    expect(replay.status).toBe(401)
    expect(await replay.text()).toBe(LOCAL_LOGIN_MESSAGE)
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})

test('local auth predicates validate token shape, deadlines, and session admission', () => {
  expect(isLoginToken(tokenId)).toBe(true)
  expect(isLoginToken('../token')).toBe(false)
  expect(deadlineIsLive(1_001, 1_000)).toBe(true)
  expect(deadlineIsLive(1_000, 1_000)).toBe(false)
  expect(sessionIsAdmitted(sessionId, 1_001, 1_000)).toBe(true)
  expect(sessionIsAdmitted(null, 1_001, 1_000)).toBe(false)
  expect(sessionIsAdmitted(sessionId, undefined, 1_000)).toBe(false)
})

test('an expired login token is consumed without creating a session', async () => {
  const state = mkdtempSync(join(tmpdir(), 'hub-login-expiry-'))
  let now = 1_000
  const auth = new LocalHubAuth(
    { [STATE_HOME_ENV]: state },
    () => now,
    () => tokenId,
  )
  try {
    const loginUrl = auth.mintLoginUrl(7778)
    now += 5 * 60 * 1000 + 1
    const response = auth.exchange(new Request(loginUrl))
    expect(response.status).toBe(401)
    expect(readdirSync(join(state, 'hub', 'login-tokens'))).toEqual([])
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})

test('a symlink planted as a login token is refused without touching its target', async () => {
  const state = mkdtempSync(join(tmpdir(), 'hub-login-symlink-'))
  const auth = new LocalHubAuth(
    { [STATE_HOME_ENV]: state },
    () => 1_000,
    () => tokenId,
  )
  try {
    const directory = join(state, 'hub', 'login-tokens')
    auth.mintLoginUrl(7778)
    rmSync(join(directory, tokenId))
    const target = join(state, 'target')
    writeFileSync(target, 'untouched', { mode: 0o600 })
    symlinkSync(target, join(directory, tokenId))

    const response = auth.exchange(new Request(`http://127.0.0.1:7778/login?token=${tokenId}`))

    expect(response.status).toBe(401)
    expect(readFileSync(target, 'utf8')).toBe('untouched')
    expect(readdirSync(directory)).toEqual([])
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})

test('a token swapped after its claim is not consumed in place of the claimed entry', () => {
  const state = mkdtempSync(join(tmpdir(), 'hub-login-swap-'))
  const path = join(state, tokenId)
  const claimPath = join(state, `.${tokenId}.claim`)
  try {
    writeFileSync(path, '2000', { mode: 0o600 })

    const expiresAt = readClaimedLoginToken(path, claimPath, () => {
      writeFileSync(path, '3000', { mode: 0o600 })
    })

    expect(expiresAt).toBe(2000)
    expect(readFileSync(path, 'utf8')).toBe('3000')
    expect(existsSync(claimPath)).toBe(false)
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})
