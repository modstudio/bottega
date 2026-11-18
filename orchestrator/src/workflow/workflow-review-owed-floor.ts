// concern: workflow-review-owed-floor
/** Resolves one cursor change and applies the pure review-owed floor decision. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { db } from '../database/db.ts'
import { projectByName } from '../project/projects.ts'
import { emptyReviewRefusal, resolveReviewBase } from '../review/review-target.ts'
import { recordReviewFunnelDecision } from '../review-funnel/review-funnel-decision-log.ts'
import { reviewFunnelVerdictForChange } from '../review-funnel/review-funnel-verdict-service.ts'
import { gitText } from './workflow-floor-evidence-checkout.ts'
import { decideReviewOwedCheckout } from './workflow-review-owed-checkout.ts'
import {
  decideReviewOwedFloor,
  type ReviewOwedFloorDecision,
} from './workflow-review-owed-decision.ts'

const argumentRemedy = 'pass `--arg branch=<branch>` or `--arg worktree=<path>`'

function gatherReviewOwedFloor(
  projectName: string,
  args: Record<string, string>,
  database: Database,
): ReviewOwedFloorDecision {
  const project = projectByName(projectName, database)
  if (!project) return { action: 'refuse', message: `project ${projectName} is not registered` }
  const worktreeArg = args.worktree?.trim() || null
  const worktreeExists = Boolean(worktreeArg && existsSync(worktreeArg))
  const checkout = decideReviewOwedCheckout({
    worktreeArg,
    worktreeExists,
    worktreeHead:
      worktreeArg && worktreeExists
        ? gitText(worktreeArg, ['rev-parse', '--abbrev-ref', 'HEAD'])
        : null,
    branchArg: args.branch?.trim() || null,
    projectPath: project.path,
  })
  if ('refusal' in checkout) return { action: 'refuse', message: checkout.refusal }
  const { cwd, branch } = checkout
  const trunk = project.settings.trunk?.trim()
  if (!trunk)
    return {
      action: 'refuse',
      message: `floor review-owed cannot resolve a base because project ${projectName} has no trunk configured`,
    }
  if (branch === trunk)
    return {
      action: 'refuse',
      message: `floor review-owed cannot evaluate configured trunk ${trunk}; ${argumentRemedy}`,
    }
  const head =
    gitText(cwd, ['rev-parse', '--verify', `${branch}^{commit}`]) ??
    gitText(cwd, ['rev-parse', '--verify', `origin/${branch}^{commit}`])
  if (!head)
    return {
      action: 'refuse',
      message: `floor review-owed cannot resolve branch ref ${branch} in ${cwd}; pass \`--arg worktree=<path>\` naming its checkout, or fetch ${branch}`,
    }
  const base = resolveReviewBase(cwd, head, trunk)
  if (!base)
    return {
      action: 'refuse',
      message: `floor review-owed cannot find a merge-base between branch ${branch} and trunk ${trunk}; pass \`--arg worktree=<path>\` naming an up-to-date checkout, or fetch ${trunk}`,
    }
  const result = reviewFunnelVerdictForChange({
    database,
    cwd,
    base,
    head,
    branch,
    project,
  })
  if (result.kind === 'empty') {
    return {
      action: 'refuse',
      message: emptyReviewRefusal(result.commit, result.base, branch, trunk)!,
    }
  }
  const { facts, verdict } = result
  const decision = decideReviewOwedFloor(verdict)
  recordReviewFunnelDecision({
    database,
    surface: 'workflow',
    outcome: decision.action === 'allow' ? 'admit' : 'refuse',
    facts,
    verdict,
  })
  return decision
}

export const productionReviewOwedFloor = (
  project: string,
  args: Record<string, string>,
): ReviewOwedFloorDecision => gatherReviewOwedFloor(project, args, db())
