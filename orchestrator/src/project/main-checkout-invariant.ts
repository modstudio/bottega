// concern: main-checkout-invariant
/** Decides and gathers the branch and tracked-cleanliness invariant for a registered main checkout. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { git } from '../git/git-environment.ts'

export type MainCheckoutFacts = {
  branch: string | null
  trunk: string
  trackedModified: boolean
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Render the one sanctioned command that returns a registered main checkout to trunk. */
export function returnMainCheckoutToTrunkCommand(path: string, trunk: string): string {
  return `git -C ${shellQuote(path)} switch ${shellQuote(trunk)}`
}

export function mainCheckoutInvariant(
  path: string,
  facts: MainCheckoutFacts,
): { holds: true } | { holds: false; message: string } {
  const failures: string[] = []
  if (facts.branch !== facts.trunk) {
    failures.push(
      `checkout branch is ${facts.branch ?? 'detached'}, not landing branch ${facts.trunk}`,
    )
  }
  if (facts.trackedModified) failures.push('checkout has tracked modifications')
  if (failures.length === 0) return { holds: true }
  const remedies = []
  if (facts.branch !== facts.trunk) {
    remedies.push(`run ${returnMainCheckoutToTrunkCommand(path, facts.trunk)}`)
  }
  if (facts.trackedModified) remedies.push('restore the tracked checkout')
  remedies.push(`run ${PLATFORM_SLUG} machine doctor`)
  return { holds: false, message: `${failures.join('; ')}; ${remedies.join(', then ')}` }
}

export function mainCheckoutFacts(
  path: string,
  trunk: string,
  runGit: (cwd: string, args: string[]) => string = (cwd, args) => git(args, cwd),
): MainCheckoutFacts {
  return {
    branch: runGit(path, ['branch', '--show-current']) || null,
    trunk,
    trackedModified: runGit(path, ['status', '--porcelain', '--untracked-files=no']).length > 0,
  }
}

export function verifyMainCheckoutInvariant(
  path: string,
  trunk: string,
  runGit?: (cwd: string, args: string[]) => string,
): void {
  const decision = mainCheckoutInvariant(path, mainCheckoutFacts(path, trunk, runGit))
  if (!decision.holds) throw new Error(`${path}: ${decision.message}`)
}
