// concern: evidence-checkout
/** Gathers checkout path identity before an evidence-writing command runs. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { gitAt, gitToplevel } from '../../../shared/git.ts'
import {
  checkoutPathsSame,
  evidenceCheckoutRefusal,
  realpathOrSpelled,
} from '../git/checkout-identity.ts'
import { mainCheckoutWorktreeHint } from '../project/projects.ts'

function shortHeadCommit(cwd: string): string | null {
  const result = gitAt(cwd, ['rev-parse', '--short=12', 'HEAD'])
  return result.code === 0 ? result.stdout.trim() || null : null
}

/** Gather checkout identity and refuse evidence that a stranded worktree-area cwd misattributes. */
export function assertEvidenceCheckoutIdentity(input: {
  cwd: string
  projectPath: string
  verb: string
  topLevel?: string | null
  resolveCommit?: (cwd: string) => string | null
}): void {
  const topLevel = input.topLevel === undefined ? gitToplevel(input.cwd) : input.topLevel
  if (!topLevel) return
  const worktreeBase = realpathOrSpelled(mainCheckoutWorktreeHint(input.projectPath))
  const normalize = (path: string): string =>
    checkoutPathsSame(path, worktreeBase) ? worktreeBase : realpathOrSpelled(path)
  const cwd = normalize(input.cwd)
  const resolvedTopLevel = normalize(topLevel)
  if (!evidenceCheckoutRefusal({ cwd, topLevel: resolvedTopLevel, worktreeBase })) return
  const commit = (input.resolveCommit ?? shortHeadCommit)(resolvedTopLevel) ?? 'unknown commit'
  throw new Error(
    `${PLATFORM_SLUG} ${input.verb}: ${input.cwd} is not a worktree; git resolves it to ${resolvedTopLevel} at ${commit}, so evidence recorded here would prove that checkout, not a branch tip.\n` +
      `cleared by: pass --cwd <the branch's worktree root> (${PLATFORM_SLUG} tree list --json), or reopen the run's tree with ${PLATFORM_SLUG} tree open <run>; remove the stranded directory if its tree is gone.`,
  )
}
