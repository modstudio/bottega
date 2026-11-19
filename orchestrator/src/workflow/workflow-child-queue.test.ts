import { expect, test } from 'bun:test'
import { type ChildTaskFact, childQueueState, selectChildToStart } from './workflow-child-queue.ts'

const task = (
  values: Partial<ChildTaskFact> & Pick<ChildTaskFact, 'key' | 'number'>,
): ChildTaskFact => ({
  parentKey: 'DEV-1',
  statusCategory: 'open',
  cursorEverComposed: false,
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
  expect(selectChildToStart(state)).toEqual({ action: 'start', task: queued })
  expect(selectChildToStart(state, 'DEV-2')).toEqual({ action: 'start', task: open })
  expect(selectChildToStart(state, 'DEV-9')).toEqual({
    action: 'refuse',
    message: 'DEV-9 is not queued for this session or Open',
  })
})
