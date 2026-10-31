import { expect, test } from 'bun:test'
import { readerCloneReclaimDecision } from './reclaim-reader-clone.ts'

const runId = '01990000-0000-7000-8000-000000001960'

test('a live creating run protects its unmarked reader clone', () => {
  expect(
    readerCloneReclaimDecision(`orch-${runId}`, [{ recordId: runId, status: 'running' }]),
  ).toEqual({
    allowed: false,
    reason: `run ${runId} status running is not terminal and may still be creating this reader clone`,
  })
})

test('a terminal or absent creating run allows its unmarked reader clone', () => {
  expect(readerCloneReclaimDecision(`orch-${runId}`, [{ recordId: runId, status: 'ok' }])).toEqual({
    allowed: true,
  })
  expect(readerCloneReclaimDecision(`orch-${runId}`, [])).toEqual({ allowed: true })
})

test('a live project run protects a shared review clone', () => {
  expect(
    readerCloneReclaimDecision('orch-review-0123456789ab', [
      { recordId: runId, status: 'waiting-input' },
    ]),
  ).toEqual({
    allowed: false,
    reason: `run ${runId} status waiting-input is not terminal; the shared review clone may still be in creation`,
  })
})
