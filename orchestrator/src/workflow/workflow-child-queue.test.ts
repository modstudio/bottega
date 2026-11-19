import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type ChildTaskFact,
  childQueueState,
  selectChildToStart,
  sessionWorksUnderEpic,
} from './workflow-child-queue.ts'

const task = (
  values: Partial<ChildTaskFact> & Pick<ChildTaskFact, 'key' | 'number'>,
): ChildTaskFact => ({
  project: 'fixture',
  parentKey: 'DEV-1',
  statusCategory: 'open',
  cursorEverComposed: false,
  cursorNumber: null,
  cursorState: null,
  liveTaskClaimSession: null,
  liveQueuedClaimSession: null,
  queuedAt: null,
  ...values,
})

test('nested epics flatten to queueable leaves in filing order', () => {
  const state = childQueueState('DEV-1', 'mine', [
    task({ key: 'DEV-2', number: 2 }),
    task({ key: 'DEV-8', number: 8, parentKey: 'DEV-2' }),
    task({ key: 'DEV-3', number: 3, cursorEverComposed: true }),
    task({ key: 'DEV-4', number: 4, liveTaskClaimSession: 'other' }),
    task({ key: 'DEV-5', number: 5, statusCategory: 'done' }),
    task({ key: 'DEV-6', number: 6, liveQueuedClaimSession: 'other', queuedAt: '2026-01-01' }),
    task({ key: 'DEV-7', number: 7 }),
  ])
  expect(state.open.map(({ key }) => key)).toEqual(['DEV-7', 'DEV-8'])
  expect(state.queue).toEqual([])
})

test('start-child picks this session queue before Open', () => {
  const queued = task({
    key: 'DEV-4',
    number: 4,
    liveQueuedClaimSession: 'mine',
    queuedAt: '2026-01-01',
  })
  const open = task({ key: 'DEV-2', number: 2 })
  const state = childQueueState('DEV-1', 'mine', [open, queued])
  expect(selectChildToStart(state, [open, queued])).toEqual({ action: 'start', task: queued })
  expect(selectChildToStart(state, [open, queued], 'DEV-2')).toEqual({
    action: 'start',
    task: open,
  })
  expect(selectChildToStart(state, [open, queued], 'DEV-9')).toEqual({
    action: 'refuse',
    message: 'DEV-9 is not queueable under this epic',
  })
})

test('a composed descendant refusal names its cursor, state, and abandon remedy', () => {
  const composed = task({
    key: 'DEV-2',
    number: 2,
    cursorEverComposed: true,
    cursorNumber: 42,
    cursorState: 'running',
  })
  const state = childQueueState('DEV-1', 'mine', [composed])
  expect(selectChildToStart(state, [composed], 'DEV-2')).toEqual({
    action: 'refuse',
    message: `DEV-2 already has a plan-task cursor 42 (running); finish it, or abandon it with ${PLATFORM_SLUG} workflow abandon --cursor 42 --project fixture, before queueing it again`,
  })
  expect(selectChildToStart(state, [composed], 'DEV-9')).toEqual({
    action: 'refuse',
    message: 'DEV-9 is not queueable under this epic',
  })
})

test('a session works under an epic through its epic claim or a queued descendant claim', () => {
  const descendants = new Set(['DEV-2', 'DEV-3'])
  expect(
    sessionWorksUnderEpic(
      [{ subject_kind: 'task', subject_value: 'DEV-1', holder_session: 'mine' }],
      'mine',
      'DEV-1',
      descendants,
    ),
  ).toBeTrue()
  expect(
    sessionWorksUnderEpic(
      [{ subject_kind: 'queued-task', subject_value: 'DEV-3', holder_session: 'mine' }],
      'mine',
      'DEV-1',
      descendants,
    ),
  ).toBeTrue()
  expect(
    sessionWorksUnderEpic(
      [
        { subject_kind: 'queued-task', subject_value: 'DEV-9', holder_session: 'mine' },
        { subject_kind: 'task', subject_value: 'DEV-1', holder_session: 'other' },
      ],
      'mine',
      'DEV-1',
      descendants,
    ),
  ).toBeFalse()
})
