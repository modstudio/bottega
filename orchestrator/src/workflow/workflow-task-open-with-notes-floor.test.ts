import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideCloseFloors,
  decideFloorSatisfaction,
  type Floor,
  type ValidatedEvidence,
} from './workflow-floor.ts'

const taskOpenWithNotes: Floor = {
  kind: 'task-open-with-notes',
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: false,
}

test('an outcome floor replaces the step floor only for its declared outcome', () => {
  const step = {
    floor: ['tracker-transition'] as const,
    outcomeFloors: { partial: ['task-open-with-notes'] as const },
  }
  expect(decideCloseFloors(step, 'partial').map((floor) => floor.kind)).toEqual([
    'task-open-with-notes',
  ])
  expect(decideCloseFloors(step, 'done').map((floor) => floor.kind)).toEqual(['tracker-transition'])
  expect(decideCloseFloors(step, undefined).map((floor) => floor.kind)).toEqual([
    'tracker-transition',
  ])
})

test('task-open-with-notes requires an open task and every named note to be live and attached', () => {
  const task = {
    key: 'DEV-977',
    status: 'open',
    statusCategory: 'open',
    mergedPullRequest: null,
    trackerStates: {},
  }
  const note = {
    reference: `${PLATFORM_SLUG}#2817`,
    recordId: '00000000-0000-4000-8000-000000000014',
    label: `${PLATFORM_SLUG}#2817`,
    promotedTask: 'DEV-977',
    staleAt: null,
  }
  const result = (evidence: ValidatedEvidence) =>
    decideFloorSatisfaction({
      floors: [taskOpenWithNotes],
      evidence,
      workflowKey: 'DEV-977',
      enforcement: 'floors',
      finishing: false,
      openObligations: [],
    })

  expect(result({ task, notes: [note] }).action).toBe('allow')
  expect(
    result({ task: { ...task, status: 'done', statusCategory: 'done' }, notes: [note] }).action,
  ).toBe('refuse')
  expect(
    result({ task: { ...task, status: 'dropped', statusCategory: 'dropped' }, notes: [note] })
      .action,
  ).toBe('refuse')
  expect(
    result({ task: { ...task, status: null, statusCategory: null }, notes: [note] }),
  ).toMatchObject({
    action: 'refuse',
    message: expect.stringContaining("DEV-977's status category could not be established"),
  })
  expect(result({ task, notes: [] }).action).toBe('refuse')
  expect(result({ task, notes: [{ ...note, promotedTask: 'DEV-978' }] }).action).toBe('refuse')
  expect(result({ task, notes: [note, { ...note, promotedTask: 'DEV-978' }] }).action).toBe(
    'refuse',
  )
  expect(result({ task, notes: [{ ...note, staleAt: '2026-11-20T00:00:00.000Z' }] }).action).toBe(
    'refuse',
  )
})
