import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ConfigEnvironment, resolveConfigRoot } from './config-directory.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function hostedConfigSpacePath(env: ConfigEnvironment = process.env): string {
  return join(resolveConfigRoot(env), 'hosted-config-space')
}

export function readHostedConfigSpace(env: ConfigEnvironment = process.env): string | null {
  const path = hostedConfigSpacePath(env)
  try {
    const value = readFileSync(path, 'utf8').trim()
    if (!UUID.test(value)) throw new Error('stored space id is malformed')
    return value.toLowerCase()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(
      `refusing hosted config bootstrap ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function writeHostedConfigSpace(
  spaceId: string,
  env: ConfigEnvironment = process.env,
): void {
  if (!UUID.test(spaceId)) throw new Error('cannot pin malformed hosted config space id')
  const root = resolveConfigRoot(env)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = hostedConfigSpacePath(env)
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${spaceId.toLowerCase()}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}
