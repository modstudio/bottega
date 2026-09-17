import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import { resolveRunsDirectory, type StateEnvironment } from './state-directory.ts'

/** Keep linked-worktree gate evidence isolated; the main checkout retains history in state. */
export function resolveGateTimingDirectory(
  absoluteCheckout: string,
  linked: boolean,
  env: StateEnvironment,
  temporaryRoot: string,
): string {
  if (!linked) return join(resolveRunsDirectory(env), 'gate-timings')
  const key = createHash('sha256').update(absoluteCheckout).digest('hex').slice(0, 12)
  return join(
    temporaryRoot,
    `${PLATFORM_SLUG}-gate-timings`,
    `${basename(absoluteCheckout)}-${key}`,
  )
}
