import { expect, test } from 'bun:test'
import type { ReviewFunnelVerdict } from './decide-review-funnel.ts'
import { type FunnelReportDecisionRow, reviewFunnelReport } from './review-funnel-report.ts'

const verdict = (next: ReviewFunnelVerdict['next']['action']): ReviewFunnelVerdict => ({
  policyVersion: 'v1',
  mode: 'evaluate',
  change: {
    project: 'p',
    taskKey: 'DEV-1',
    branch: 'b',
    head: 'h',
    patchId: 'patch',
    pathSet: '[]',
    paths: [],
  },
  tier: { tier: 1, risk: 1, size: 1, firm: false, lowered: false, reasons: [] },
  budget: { roundsUsed: 0, ceiling: 1, atCeiling: false },
  lenses: [],
  next: { action: next },
  remedy: 'command',
})

const row = (
  surface: FunnelReportDecisionRow['surface'],
  outcome: FunnelReportDecisionRow['outcome'],
  next: ReviewFunnelVerdict['next']['action'],
  recordedAt: string,
) => ({
  project: 'p',
  stack: 'ts',
  taskKey: 'DEV-1',
  patchId: 'patch',
  pathSet: '[]',
  surface,
  outcome,
  verdict: verdict(next),
  recordedAt,
})

test('counts one tier-versus-admission disagreement for the same change identity', () => {
  const [report] = reviewFunnelReport(
    [
      row('review-tier', 'advice', 'admit', '2026-01-01'),
      row('admission', 'refuse', 'dispatch', '2026-01-02'),
    ],
    [],
  )
  expect(report!.tierAdmissionDisagreements).toBe(1)
  expect(report!.refusalsAfterFollowingTier).toBe(1)
})
