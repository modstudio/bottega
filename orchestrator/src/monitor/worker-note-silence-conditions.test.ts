import { expect, test } from 'bun:test'
import {
  WORKER_NOTE_SILENCE_WINDOW_MS,
  type WorkerNoteSilenceFacts,
  workerNoteSilenceCondition,
} from './worker-note-silence-conditions.ts'

const clock = new Date('2026-10-31T20:00:00.000Z').getTime()
const refused: WorkerNoteSilenceFacts = {
  refusalCount: 3,
  filedCount: 0,
  latestRefusalClass: 'filing-refused',
  latestRefusalDetail: 'anchor schema mismatch',
  latestRefusalAt: '2026-10-31T19:00:00.000Z',
}

test('refusals with no filing report worker-note silence', () => {
  expect(workerNoteSilenceCondition(refused, clock)).toMatchObject({
    kind: 'worker-note-silence',
    detail: expect.stringContaining('3 worker note request(s)'),
    action: expect.stringContaining('note new'),
  })
})

test('one filing suppresses worker-note silence', () => {
  expect(workerNoteSilenceCondition({ ...refused, filedCount: 1 }, clock)).toBeNull()
})

test('no requests do not report worker-note silence', () => {
  expect(
    workerNoteSilenceCondition(
      {
        refusalCount: 0,
        filedCount: 0,
        latestRefusalClass: null,
        latestRefusalDetail: null,
        latestRefusalAt: null,
      },
      clock,
    ),
  ).toBeNull()
})

test('refusals outside the observation window are ignored', () => {
  expect(
    workerNoteSilenceCondition(
      {
        ...refused,
        latestRefusalAt: new Date(clock - WORKER_NOTE_SILENCE_WINDOW_MS - 1).toISOString(),
      },
      clock,
    ),
  ).toBeNull()
})
