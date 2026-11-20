// concern: workflow-review-owed-floor
/** Resolves one cursor change and applies the pure review-owed floor decision. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { emptyReviewRefusal, resolveReviewBase } from '../review/review-target.ts'
import { recordReviewFunnelDecision } from '../review-funnel/review-funnel-decision-log.ts'
import { reviewFunnelVerdictForChange } from '../review-funnel/review-funnel-verdict-service.ts'
import {
  resolveBranchUnderReview,
  reviewOwedArgumentRemedy,
} from './workflow-review-owed-checkout.ts'
import {
  decideReviewOwedFloor,
  type ReviewOwedFloorDecision,
} from './workflow-review-owed-decision.ts'

function gatherReviewOwedFloor(
  projectName: string,
  args: Record<string, string>,
  database: Database,
): ReviewOwedFloorDecision {
  const resolved = resolveBranchUnderReview(projectName, args, database)
  if (resolved.action === 'refuse') {
    if (resolved.kind !== 'tip') return { action: 'refuse', message: resolved.condition }
    return {
      action: 'refuse',
      message: `floor review-owed cannot resolve branch ref ${resolved.branch} in ${resolved.cwd}; pass \`--arg worktree=<path>\` naming its checkout, or fetch ${resolved.branch}`,
    }
  }
  const { project, cwd, branch, tip: head } = resolved
  const trunk = project.settings.trunk?.trim()
  if (!trunk)
    return {
      action: 'refuse',
      message: `floor review-owed cannot resolve a base because project ${projectName} has no trunk configured`,
    }
  if (branch === trunk)
    return {
      action: 'refuse',
      message: `floor review-owed cannot evaluate configured trunk ${trunk}; ${reviewOwedArgumentRemedy}`,
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
  return { ...decision, noLensOwed: verdict.next.action !== 'dispatch' }
}

export const productionReviewOwedFloor = (
  project: string,
  args: Record<string, string>,
): ReviewOwedFloorDecision => gatherReviewOwedFloor(project, args, db())
