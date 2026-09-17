import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import { resolveRunsDirectory, type StateEnvironment } from './state-directory.ts'

/** Keep linked-worktree gate evidence isolated; the main checkout retains history in state. */
export function resolveGateTimingDirectory(checkout: string, env: StateEnvironment): string {
  const absoluteCheckout = resolve(checkout)
  const linked = lstatSync(join(absoluteCheckout, '.git')).isFile()
  if (!linked) return join(resolveRunsDirectory(env), 'gate-timings')
  const key = createHash('sha256').update(absoluteCheckout).digest('hex').slice(0, 12)
  return join(tmpdir(), `${PLATFORM_SLUG}-gate-timings`, `${basename(absoluteCheckout)}-${key}`)
}
