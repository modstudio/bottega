import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideFloorSatisfaction, type Floor, type ValidatedEvidence } from './workflow-floor.ts'

const tracker: Floor = {
  kind: 'tracker-transition',
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: true,
  operatorRuling: false,
}

const decide = (evidence: ValidatedEvidence) =>
  decideFloorSatisfaction({
    floors: [tracker],
    evidence,
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
  })

const evidence = (
  mergedPullRequest: boolean | null,
  pullRequestUnavailable?: NonNullable<
    NonNullable<ValidatedEvidence['task']>['pullRequestUnavailable']
  >,
): ValidatedEvidence => ({
  task: {
    key: 'DEV-1732',
    status: 'done',
    statusCategory: 'done',
    mergedPullRequest,
    ...(pullRequestUnavailable ? { pullRequestUnavailable } : {}),
    trackerStates: {},
  },
})

test('tracker-transition distinguishes merged, unmerged, and unavailable pull requests', () => {
  expect(decide(evidence(true))).toMatchObject({ action: 'allow' })

  const unmerged = decide(evidence(false))
  expect(unmerged).toMatchObject({ action: 'refuse' })
  if (unmerged.action === 'refuse') expect(unmerged.message).toContain('merged pull request')

  const unrecorded = decide(
    evidence(null, {
      kind: 'unrecorded',
      reason: 'no pull request is recorded for task branch DEV-1732-work',
      branch: 'DEV-1732-work',
    }),
  )
  expect(unrecorded).toMatchObject({ action: 'refuse' })
  if (unrecorded.action === 'refuse') {
    expect(unrecorded.message).toContain(
      'no pull request is recorded for task branch DEV-1732-work',
    )
    expect(unrecorded.message).toContain(
      `${PLATFORM_SLUG} tree branch landed DEV-1732-work --pr <number>`,
    )
  }

  const unreadable = decide(
    evidence(null, {
      kind: 'read-error',
      reason: 'gh unavailable',
    }),
  )
  expect(unreadable).toMatchObject({ action: 'refuse' })
  if (unreadable.action === 'refuse') {
    expect(unreadable.message).toContain('gh unavailable')
    expect(unreadable.message).toContain('rerun the close when GitHub is reachable')
  }
})
