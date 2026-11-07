// concern: main-checkout-invariant
/** Decides and gathers the branch and tracked-cleanliness invariant for a registered main checkout. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { git } from '../git/git-environment.ts'

export type MainCheckoutFacts = {
  branch: string | null
  trunk: string
  trackedModified: boolean
}

export function mainCheckoutInvariant(
  facts: MainCheckoutFacts,
): { holds: true } | { holds: false; message: string } {
  const failures: string[] = []
  if (facts.branch !== facts.trunk) {
    failures.push(
      `checkout branch is ${facts.branch ?? 'detached'}, not landing branch ${facts.trunk}`,
    )
  }
  if (facts.trackedModified) failures.push('checkout has tracked modifications')
  return failures.length
    ? {
        holds: false,
        message: `${failures.join('; ')}; restore the tracked checkout and run ${PLATFORM_SLUG} machine doctor`,
      }
    : { holds: true }
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
  const decision = mainCheckoutInvariant(mainCheckoutFacts(path, trunk, runGit))
  if (!decision.holds) throw new Error(`${path}: ${decision.message}`)
}
