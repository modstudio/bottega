import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  ensureHubLoginTokenDirectory,
  hubLoginTokenDirectory,
  type StateEnvironment,
} from '../../shared/state-directory.ts'

const LOGIN_TOKEN_EXPIRY_MS = 5 * 60 * 1000
const SESSION_EXPIRY_MS = 12 * 60 * 60 * 1000
const SESSION_COOKIE = 'hub_session'
export const LOCAL_LOGIN_MESSAGE = 'Local hub session required; run `hub login`.'

type Clock = () => number
type RandomId = () => string

function secureRandomId(): string {
  return randomBytes(32).toString('hex')
}

export function isLoginToken(token: string): boolean {
  return /^[a-f0-9]{64}$/.test(token)
}

export function deadlineIsLive(expiresAt: number, now: number): boolean {
  return Number.isFinite(expiresAt) && expiresAt > now
}

export function sessionIsAdmitted(
  sessionId: string | null,
  expiresAt: number | undefined,
  now: number,
): boolean {
  return Boolean(sessionId) && expiresAt !== undefined && deadlineIsLive(expiresAt, now)
}

function tokenPath(token: string, env: StateEnvironment): string | null {
  if (!isLoginToken(token)) return null
  return join(hubLoginTokenDirectory(env), token)
}

export function readClaimedLoginToken(
  path: string,
  claimPath: string,
  afterClaim: () => void = () => {},
): number | null {
  try {
    renameSync(path, claimPath)
  } catch {
    return null
  }

  let descriptor: number | null = null
  try {
    afterClaim()
    descriptor = openSync(claimPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(descriptor)
    const currentUid = process.getuid?.()
    if (
      !stat.isFile() ||
      currentUid === undefined ||
      stat.uid !== currentUid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1
    ) {
      return null
    }
    return Number(readFileSync(descriptor, 'utf8'))
  } catch {
    return null
  } finally {
    if (descriptor !== null) closeSync(descriptor)
    try {
      unlinkSync(claimPath)
    } catch {
      // A refused claim may already have been removed by a concurrent actor.
    }
  }
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    return part.slice(separator + 1).trim()
  }
  return null
}

/** The local server's memory-only sessions and its one-time disk token exchange. */
export class LocalHubAuth {
  private readonly sessions = new Map<string, number>()
  private readonly env: StateEnvironment
  private readonly clock: Clock
  private readonly randomId: RandomId

  constructor(
    env: StateEnvironment = process.env,
    clock: Clock = Date.now,
    randomId: RandomId = secureRandomId,
  ) {
    this.env = env
    this.clock = clock
    this.randomId = randomId
  }

  mintLoginUrl(port: number): string {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('usage: hub login [--port N]')
    }
    ensureHubLoginTokenDirectory(this.env)
    const token = this.randomId()
    const path = tokenPath(token, this.env)
    if (!path) throw new Error('hub: random login token has an invalid shape')
    const descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      fchmodSync(descriptor, 0o600)
      writeFileSync(descriptor, String(this.clock() + LOGIN_TOKEN_EXPIRY_MS), 'utf8')
    } finally {
      closeSync(descriptor)
    }
    return `http://127.0.0.1:${port}/login?token=${encodeURIComponent(token)}`
  }

  exchange(request: Request): Response {
    const url = new URL(request.url)
    const token = url.searchParams.get('token') ?? ''
    const path = tokenPath(token, this.env)
    if (!path) return new Response(LOCAL_LOGIN_MESSAGE, { status: 401 })

    const claimPath = join(hubLoginTokenDirectory(this.env), `.${token}.${secureRandomId()}.claim`)
    const expiresAt = readClaimedLoginToken(path, claimPath)
    if (expiresAt === null) {
      return new Response(LOCAL_LOGIN_MESSAGE, { status: 401 })
    }
    if (!deadlineIsLive(expiresAt, this.clock())) {
      return new Response(LOCAL_LOGIN_MESSAGE, { status: 401 })
    }

    const sessionId = this.randomId()
    this.sessions.set(sessionId, this.clock() + SESSION_EXPIRY_MS)
    const maxAge = Math.floor(SESSION_EXPIRY_MS / 1000)
    return new Response(null, {
      status: 303,
      headers: {
        location: new URL('/', url).toString(),
        'set-cookie': `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
      },
    })
  }

  allows(request: Request): boolean {
    const sessionId = cookieValue(request, SESSION_COOKIE)
    const expiresAt = sessionId ? this.sessions.get(sessionId) : undefined
    if (!sessionIsAdmitted(sessionId, expiresAt, this.clock())) {
      if (sessionId && expiresAt !== undefined) this.sessions.delete(sessionId)
      return false
    }
    return true
  }
}
