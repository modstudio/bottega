import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ConfigEnvironment, resolveConfigRoot } from './config-directory.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function hostedConfigSpacePath(env: ConfigEnvironment = process.env): string {
  return join(resolveConfigRoot(env), 'hosted-config-space')
}

export type HostedConfigIdentity = { spaceId: string; userId: string }

export function readHostedConfigIdentity(
  env: ConfigEnvironment = process.env,
): HostedConfigIdentity | null {
  const path = hostedConfigSpacePath(env)
  try {
    if ((statSync(path).mode & 0o077) !== 0) throw new Error('permissions are wider than 0600')
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<HostedConfigIdentity>
    if (!UUID.test(value.spaceId ?? '')) throw new Error('stored space id is malformed')
    if (!UUID.test(value.userId ?? '')) throw new Error('stored user id is malformed')
    return { spaceId: value.spaceId!.toLowerCase(), userId: value.userId!.toLowerCase() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(
      `refusing hosted config bootstrap ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function writeHostedConfigIdentity(
  identity: HostedConfigIdentity,
  env: ConfigEnvironment = process.env,
): void {
  if (!UUID.test(identity.spaceId)) throw new Error('cannot pin malformed hosted config space id')
  if (!UUID.test(identity.userId)) throw new Error('cannot pin malformed hosted config user id')
  const root = resolveConfigRoot(env)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = hostedConfigSpacePath(env)
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(
    temporary,
    `${JSON.stringify({
      spaceId: identity.spaceId.toLowerCase(),
      userId: identity.userId.toLowerCase(),
    })}\n`,
    { mode: 0o600, flag: 'wx' },
  )
  try {
    linkSync(temporary, path)
  } finally {
    unlinkSync(temporary)
  }
}
