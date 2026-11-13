// concern: review-funnel-commands
/** Thin command services for reporting, replaying, and changing the global funnel policy. */
import { readFileSync } from 'node:fs'
import { db } from '../database/db.ts'
import type { ReviewFunnelFacts, ReviewFunnelVerdict } from './decide-review-funnel.ts'
import {
  activeReviewFunnelPolicy,
  parseReviewFunnelPolicy,
  reviewFunnelPolicyAt,
  setReviewFunnelPolicy,
} from './review-funnel-policy.ts'
import { replayReviewFunnelRows } from './review-funnel-replay.ts'
import { reviewFunnelReport } from './review-funnel-report.ts'
import { reviewFunnelDecisionRows, reviewFunnelFindingRows } from './review-funnel-store.ts'

type Flags = { has(name: string): boolean; flag(name: string): string | undefined }
type Presentation = { log(...values: unknown[]): void }

export function reportReviewFunnelCommand(flags: Flags, { log }: Presentation): void {
  const database = db()
  const report = reviewFunnelReport(
    reviewFunnelDecisionRows(database),
    reviewFunnelFindingRows(database),
  )
  if (flags.has('json')) {
    log(JSON.stringify(report))
    return
  }
  if (!report.length) {
    log('No review-funnel decisions recorded.')
    return
  }
  for (const row of report)
    log(
      `${row.project} stack=${row.stack ?? 'unknown'} disagreements=${row.tierAdmissionDisagreements} ` +
        `refusals_after_following_tier=${row.refusalsAfterFollowingTier} rounds=${JSON.stringify(row.roundsPerTier)} ` +
        `accepted=${JSON.stringify(row.acceptedFindingsPerRound)} unique=${JSON.stringify(row.uniqueFindingsPerRound)}`,
    )
}

function policyFile(path: string) {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw new Error(`policy file ${path} is not valid JSON: ${String(cause)}; correct ${path}`)
  }
  try {
    return parseReviewFunnelPolicy(value)
  } catch (cause) {
    throw new Error(`policy file ${path} is invalid: ${String(cause)}; correct ${path}`)
  }
}

function policyFromFlags(flags: Flags) {
  const version = flags.flag('policy')
  const file = flags.flag('policy-file')
  if (Boolean(version) === Boolean(file))
    throw new Error('supply exactly one of --policy <version> or --policy-file <path>')
  if (file)
    return {
      policy: policyFile(file),
      policyVersion: `file:${file}`,
    }
  return reviewFunnelPolicyAt(version!)
}

export function replayReviewFunnelCommand(flags: Flags, { log }: Presentation): void {
  const candidate = policyFromFlags(flags)
  const rows = db()
    .query<{ record_id: string; facts: string; verdict: string }, []>(
      'SELECT record_id,facts,verdict FROM review_funnel_decision ORDER BY recorded_at,record_id',
    )
    .all()
    .map((row) => ({
      recordId: row.record_id,
      facts: JSON.parse(row.facts) as ReviewFunnelFacts,
      verdict: JSON.parse(row.verdict) as ReviewFunnelVerdict,
    }))
  const diffs = replayReviewFunnelRows(rows, candidate)
  const result = {
    policyVersion: candidate.policyVersion,
    rows: db().query('SELECT count(*) AS count FROM review_funnel_decision').get() as {
      count: number
    },
    diffCount: diffs.length,
    diffs,
  }
  log(
    flags.has('json')
      ? JSON.stringify(result)
      : `Replay ${candidate.policyVersion}: ${result.rows.count} row(s), ${diffs.length} diff(s).`,
  )
}

export async function policyReviewFunnelCommand(
  flags: Flags,
  { log }: Presentation,
): Promise<void> {
  const file = flags.flag('set')
  if (!file) {
    const active = activeReviewFunnelPolicy()
    return log(JSON.stringify({ revision: active.policyVersion, policy: active.policy }, null, 2))
  }
  const policy = policyFile(file)
  const written = await setReviewFunnelPolicy(policy)
  log(JSON.stringify({ revision: written.revision, policy }, null, 2))
}
