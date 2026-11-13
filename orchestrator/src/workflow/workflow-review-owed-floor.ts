// concern: workflow-review-owed-floor
/** Resolves one cursor change and applies the pure review-owed floor decision. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { projectByName } from '../project/projects.ts'
import { resolveReviewBase } from '../review/review-target.ts'
import { decideReviewFunnel } from '../review-funnel/decide-review-funnel.ts'
import { gatherFunnelFacts } from '../review-funnel/gather-funnel-facts.ts'
import { activeReviewFunnelPolicy } from '../review-funnel/review-funnel-policy.ts'
import { gitText } from './workflow-floor-evidence-checkout.ts'
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
  const worktree = args.worktree?.trim()
  const cwd = worktree || project.path
  const branch = worktree
    ? gitText(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])
    : args.branch?.trim()
  if (!branch || branch === 'HEAD')
    return {
      action: 'refuse',
      message: `floor review-owed cannot resolve the cursor branch; ${argumentRemedy}`,
    }
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
  const activePolicy = activeReviewFunnelPolicy()
  return decideReviewOwedFloor(
    decideReviewFunnel(
      gatherFunnelFacts({ database, cwd, base, head, branch, project }),
      activePolicy.policy,
      activePolicy.policyVersion,
    ),
  )
}

export const productionReviewOwedFloor = (
  project: string,
  args: Record<string, string>,
): ReviewOwedFloorDecision => gatherReviewOwedFloor(project, args, db())
