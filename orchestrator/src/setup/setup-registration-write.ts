// concern: setup-registration-write
/** Guards persisted harness registrations from naming an ephemeral linked worktree. */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { installRoot } from '../../../shared/install-root.ts'

export function mcpRegistrationWriteRefusal(
  root: string,
  linked: boolean,
  mainCheckout: string | null,
): string | null {
  if (!linked) return null
  const main = mainCheckout ?? 'the main checkout'
  return `refusing to write ${PLATFORM_NAME} MCP registrations from linked worktree ${root}; run this command from the main checkout ${main}`
}

function linkedWorktreeMain(root: string): string | null {
  const dotGit = join(root, '.git')
  if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return null
  const pointer = readFileSync(dotGit, 'utf8')
  const gitDir = resolve(root, pointer.trim().replace(/^gitdir:\s*/, ''))
  return dirname(resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()))
}

/** Refuse persisted harness configuration which would name an ephemeral linked worktree. */
export function assertMcpRegistrationWriteAllowed(): void {
  const root = installRoot()
  const main = linkedWorktreeMain(root)
  const refusal = mcpRegistrationWriteRefusal(root, main !== null, main)
  if (refusal) throw new Error(refusal)
}
