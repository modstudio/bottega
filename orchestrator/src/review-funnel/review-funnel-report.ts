// concern: review-funnel-report
/** Reduces plain logged decision and finding rows into review-funnel measurements. */
import type { ReviewFunnelVerdict } from './decide-review-funnel.ts'

export type FunnelReportDecisionRow = {
  project: string
  stack: string | null
  taskKey: string | null
  patchId: string
  pathSet: string
  surface: string
  outcome: 'advice' | 'admit' | 'refuse'
  verdict: ReviewFunnelVerdict
  recordedAt: string
}

export type FunnelReportFindingRow = {
  project: string
  stack: string | null
  tier: number
  round: number
  accepted: number
  unique: number
}

export type FunnelReportGroup = {
  project: string
  stack: string | null
  tierAdmissionDisagreements: number
  refusalsAfterFollowingTier: number
  roundsPerTier: Record<string, number>
  acceptedFindingsPerRound: Record<string, number>
  uniqueFindingsPerRound: Record<string, number>
}

const identity = (row: FunnelReportDecisionRow) =>
  `${row.taskKey ?? ''}\0${row.patchId}\0${row.pathSet}`

export function reviewFunnelReport(
  decisions: readonly FunnelReportDecisionRow[],
  findings: readonly FunnelReportFindingRow[],
): FunnelReportGroup[] {
  const grouped = new Map<string, FunnelReportGroup>()
  const groupFor = (project: string, stack: string | null) => {
    const key = `${project}\0${stack ?? ''}`
    let group = grouped.get(key)
    if (!group) {
      group = {
        project,
        stack,
        tierAdmissionDisagreements: 0,
        refusalsAfterFollowingTier: 0,
        roundsPerTier: {},
        acceptedFindingsPerRound: {},
        uniqueFindingsPerRound: {},
      }
      grouped.set(key, group)
    }
    return group
  }
  const changes = new Map<string, FunnelReportDecisionRow[]>()
  for (const row of [...decisions].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
    groupFor(row.project, row.stack)
    const rows = changes.get(identity(row)) ?? []
    rows.push(row)
    changes.set(identity(row), rows)
  }
  for (const rows of changes.values()) {
    const advice = rows.filter((row) => row.outcome === 'advice')
    const admissions = rows.filter((row) => row.surface !== 'review-tier')
    const group = groupFor(rows[0]!.project, rows[0]!.stack)
    if (
      advice.length &&
      admissions.some(
        (row) =>
          row.verdict.next.action !== advice.at(-1)!.verdict.next.action ||
          row.outcome !== (advice.at(-1)!.verdict.next.action === 'admit' ? 'admit' : 'refuse'),
      )
    )
      group.tierAdmissionDisagreements += 1
    rows.forEach((row, index) => {
      if (
        row.outcome === 'refuse' &&
        index > 0 &&
        rows[index - 1]!.outcome === 'advice' &&
        rows[index - 1]!.verdict.next.action === 'admit'
      )
        group.refusalsAfterFollowingTier += 1
    })
    const verdicts = rows.map((row) => row.verdict)
    for (const tier of new Set(verdicts.map((verdict) => verdict.tier.tier))) {
      group.roundsPerTier[String(tier)] = Math.max(
        group.roundsPerTier[String(tier)] ?? 0,
        ...verdicts
          .filter((verdict) => verdict.tier.tier === tier)
          .map((verdict) => verdict.budget.roundsUsed),
      )
    }
  }
  for (const row of findings) {
    const group = groupFor(row.project, row.stack)
    const key = `${row.tier}:${row.round}`
    group.acceptedFindingsPerRound[key] = (group.acceptedFindingsPerRound[key] ?? 0) + row.accepted
    group.uniqueFindingsPerRound[key] = (group.uniqueFindingsPerRound[key] ?? 0) + row.unique
  }
  return [...grouped.values()].sort((a, b) =>
    `${a.project}\0${a.stack ?? ''}`.localeCompare(`${b.project}\0${b.stack ?? ''}`),
  )
}
