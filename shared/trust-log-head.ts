import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ConfigEnvironment, resolveConfigRoot } from './config-directory.ts'

function pathFor(spaceId: string, env: ConfigEnvironment): string {
  if (!/^[A-Za-z0-9_-]+$/.test(spaceId))
    throw new Error('refusing trust log head: space id is not safe as a file name')
  return join(resolveConfigRoot(env), 'trust-log-heads', spaceId)
}

export function readRememberedTrustLogHead(
  spaceId: string,
  env: ConfigEnvironment = process.env,
): Uint8Array | null {
  const path = pathFor(spaceId, env)
  let value: string
  try {
    const stat = statSync(path)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error(`refusing remembered trust log head ${path}: permissions must be 0600`)
    value = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const normalized = value.trim()
  if (!/^[0-9a-f]{64}$/.test(normalized))
    throw new Error(`refusing remembered trust log head ${path}: contents must be lowercase hex`)
  return new Uint8Array(Buffer.from(normalized, 'hex'))
}

export function writeRememberedTrustLogHead(
  spaceId: string,
  head: Uint8Array,
  env: ConfigEnvironment = process.env,
): void {
  if (head.byteLength !== 32)
    throw new Error('refusing remembered trust log head: head must be 32 bytes')
  const directory = join(resolveConfigRoot(env), 'trust-log-heads')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const path = pathFor(spaceId, env)
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${Buffer.from(head).toString('hex')}\n`, { mode: 0o600, flag: 'wx' })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}
