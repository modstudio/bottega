// concern: workflow floor evidence checkout adapter
/** Resolves checkout provenance through git and recorded landing facts. */

import type { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { projectAt, projectByName } from '../project/projects.ts'
import { checkoutLanding } from './workflow-checkout-landing.ts'
import { type CheckoutResolution, decideCheckoutAnswer } from './workflow-checkout-refusal.ts'

export function gitText(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function gitOk(cwd: string, args: string[]): boolean {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status === 0
}

function cwdProject(
  cwd: string,
  identity: { project: string; worktree: string | null },
  d: Database,
): string | null {
  const at = projectAt(cwd, d)?.name ?? null
  if (at) return at
  const tree = identity.worktree
  if (tree && (cwd === tree || cwd.startsWith(`${tree}/`))) return identity.project
  return null
}

export function productionResolveCheckout(
  cwd: string,
  headCommit: string | null,
  expectedBranch: string | null,
  identity: { project: string; worktree: string | null },
  d: Database,
): CheckoutResolution {
  const registered = projectByName(identity.project, d)
  const answer = decideCheckoutAnswer({
    recordedCwd: cwd,
    recordedCwdIsDirectory: existsSync(cwd) && statSync(cwd).isDirectory(),
    mainCheckoutPath: registered?.path ?? null,
  })
  if ('refusal' in answer) throw new Error(answer.refusal)
  const checkout = answer.checkoutPath
  const project = cwdProject(checkout, identity, d)
  const branch = gitText(checkout, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const tip = expectedBranch
    ? (gitText(checkout, ['rev-parse', '--verify', expectedBranch]) ??
      gitText(checkout, ['rev-parse', '--verify', `origin/${expectedBranch}`]))
    : gitText(checkout, ['rev-parse', 'HEAD'])
  const headIsTipOrAncestor = Boolean(
    headCommit && tip && gitOk(checkout, ['merge-base', '--is-ancestor', headCommit, tip]),
  )
  const landing = headIsTipOrAncestor
    ? { commit: null, recordedTip: null }
    : checkoutLanding(identity.project, expectedBranch, d)
  const landingCommit = landing.commit
  const landingCommitAvailable = Boolean(
    landingCommit && gitOk(checkout, ['cat-file', '-e', `${landingCommit}^{commit}`]),
  )
  const landingIsHeadOrAncestor = landingCommitAvailable
    ? Boolean(
        landingCommit &&
          headCommit &&
          gitOk(checkout, ['merge-base', '--is-ancestor', landingCommit, headCommit]),
      )
    : undefined
  const recordedLandingTip = tip ? null : landing.recordedTip
  const headIsRecordedTipOrAncestor = Boolean(
    headCommit &&
      recordedLandingTip &&
      gitOk(checkout, ['merge-base', '--is-ancestor', headCommit, recordedLandingTip]),
  )
  const landingBranch = registered?.settings.trunk ?? 'main'
  const landingIsOnTrunk = Boolean(
    landingCommitAvailable &&
      landingCommit &&
      [`origin/${landingBranch}`, landingBranch].some((ref) =>
        gitOk(checkout, ['merge-base', '--is-ancestor', landingCommit, ref]),
      ),
  )
  return {
    project,
    branch,
    checkoutPath: checkout,
    headIsTipOrAncestor,
    landingCommit,
    landingIsHeadOrAncestor,
    landingBranch,
    recordedLandingTip,
    headIsRecordedTipOrAncestor,
    landingIsOnTrunk,
  }
}
