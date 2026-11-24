import { expect, test } from 'bun:test'
import {
  cursorClaimHealth,
  cursorClaimHealthConditionsForProjects,
  openKeyedCursorFacts,
} from './monitor-cursor-claims.ts'

test('cursor claim health preserves bound lapsed claims and splits both classes by epic', () => {
  const cursors = [
    { project: 'p', id: 1, key: 'DEV-1', session: 'alive', isEpic: true },
    { project: 'p', id: 2, key: 'DEV-2', session: 'dead', isEpic: false },
    { project: 'p', id: 3, key: 'DEV-3', session: 'alive', isEpic: false },
  ]
  const claims = [{ project: 'p', key: 'DEV-1', session: 'alive', live: true }]

  expect(cursorClaimHealth(cursors, claims, new Set(['alive']))).toEqual({
    unclaimed: { epic: [], nonEpic: [2, 3] },
    ownerNotAlive: { epic: [], nonEpic: [2] },
  })
})

test('cursor claim health reports an unclaimed epic independently', () => {
  expect(
    cursorClaimHealth(
      [{ project: 'p', id: 9, key: 'DEV-9', session: 'alive', isEpic: true }],
      [],
      new Set(['alive']),
    ),
  ).toEqual({
    unclaimed: { epic: [9], nonEpic: [] },
    ownerNotAlive: { epic: [], nonEpic: [] },
  })
})

test('a plan-task cursor at start is non-epic when no child flow names its flow', () => {
  expect(
    openKeyedCursorFacts(
      'p',
      [
        {
          id: 10,
          workflow_key: 'DEV-10',
          session_id: 'session',
          task_flow_record_id: 'flow-10',
        },
      ],
      new Set(),
    ),
  ).toEqual([
    {
      project: 'p',
      id: 10,
      key: 'DEV-10',
      session: 'session',
      isEpic: false,
    },
  ])
})

test('an unreadable project is reported while readable projects are still counted', async () => {
  const conditions = await cursorClaimHealthConditionsForProjects(
    ['broken', 'readable'],
    new Set(['alive']),
    async (project) => {
      if (project === 'broken') throw new Error('task list unavailable')
      return {
        cursors: [{ project: 'readable', id: 11, key: 'DEV-11', session: 'alive', isEpic: false }],
        claims: [],
      }
    },
  )

  expect(conditions).toEqual([
    expect.objectContaining({
      kind: 'observation-error',
      subject: 'workflow-cursors:broken',
      detail: expect.stringContaining('broken cursor claim observation unavailable'),
    }),
    expect.objectContaining({
      kind: 'open-cursor-unclaimed',
      detail: expect.stringContaining('epic 0 [none]; non-epic 1 [11]'),
    }),
  ])
})
