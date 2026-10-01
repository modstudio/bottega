import { expect, test } from 'bun:test'
import { type RecordedGateCandidate, selectRecordedGateResult } from './gate-result.ts'

test('recorded gate result is the most recent finished execution for the exact project commit', () => {
  const row = (
    id: number,
    projectId: number,
    headCommit: string,
    finishedAt: string,
  ): RecordedGateCandidate => ({
    id,
    projectId,
    headCommit,
    runId: id + 100,
    exitCode: 0,
    timedOut: false,
    elapsedMs: 20,
    finishedAt,
    outputTail: `gate ${id}`,
  })
  const target = { projectId: 7, headCommit: 'reviewed' }
  expect(
    selectRecordedGateResult(
      [
        row(1, 7, 'reviewed', '2026-09-30T12:00:00.000Z'),
        row(2, 8, 'reviewed', '2026-10-01T12:00:00.000Z'),
        row(3, 7, 'other', '2026-10-01T13:00:00.000Z'),
        row(4, 7, 'reviewed', '2026-10-01T11:00:00.000Z'),
        row(5, 7, 'reviewed', '2026-10-01T11:00:00.000Z'),
      ],
      target,
    )?.id,
  ).toBe(5)
  expect(
    selectRecordedGateResult([row(6, 8, 'reviewed', '2026-10-01T14:00:00.000Z')], target),
  ).toBeNull()
})
