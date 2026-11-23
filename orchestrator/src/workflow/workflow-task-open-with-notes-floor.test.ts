import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideStepOutcome } from './workflow-cursor-transition.ts'
import {
  decideCloseFloors,
  decideFloorSatisfaction,
  type Floor,
  type ValidatedEvidence,
} from './workflow-floor.ts'
import { parseWorkflowTree } from './workflow-tree.ts'
import { collectWorkflowTree } from './workflow-tree-files.ts'

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
    requirePullRequest: true,
  }
  expect(decideCloseFloors(step, 'partial')).toMatchObject([
    { kind: 'task-open-with-notes', requirePullRequest: true },
  ])
  expect(decideCloseFloors(step, 'done').map((floor) => floor.kind)).toEqual(['tracker-transition'])
  expect(decideCloseFloors(step, undefined).map((floor) => floor.kind)).toEqual([
    'tracker-transition',
  ])
})

test('waiting-for-review applies its authored review and slice outcome floors', () => {
  const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const waiting = parseWorkflowTree(collectWorkflowTree(repositoryRoot)).steps.find(
    ({ slug }) => slug === 'waiting-for-review',
  )!
  const step = {
    ...waiting,
    floor: ['tracker-transition'] as const,
    expectedStatus: ['checking', 'checking'],
  }
  const note = {
    reference: `${PLATFORM_SLUG}#2866`,
    recordId: '00000000-0000-4000-8000-000000000866',
    label: `${PLATFORM_SLUG}#2866`,
    promotedTask: 'DEV-1178',
    staleAt: null,
  }
  const task = (status: string, statusCategory: string) => ({
    key: 'DEV-1178',
    status,
    statusCategory,
    mergedPullRequest: false,
    trackerStates: { started: 'active', checking: 'review', completed: 'done' } as const,
  })
  const satisfaction = (outcome: 'review' | 'slice', status: string, statusCategory: string) =>
    decideFloorSatisfaction({
      floors: decideCloseFloors(step, outcome),
      evidence: { task: task(status, statusCategory), notes: [note] },
      workflowKey: 'DEV-1178',
      enforcement: 'floors',
      finishing: false,
      openObligations: [],
    })

  expect(waiting).toMatchObject({
    outcomes: ['review', 'slice'],
    outcomeFloors: { slice: ['task-open-with-notes'] },
  })
  expect(decideCloseFloors(step, 'slice')).toMatchObject([
    { kind: 'task-open-with-notes', requirePullRequest: false },
  ])
  expect(satisfaction('slice', 'open', 'open').action).toBe('allow')
  expect(satisfaction('slice', 'completed', 'done').action).toBe('refuse')
  expect(satisfaction('review', 'checking', 'review').action).toBe('allow')
  expect(satisfaction('review', 'started', 'active')).toMatchObject({
    action: 'refuse',
    message: expect.stringContaining('floor tracker-transition is unmet; pass --task <KEY>'),
  })
  expect(decideStepOutcome(waiting.slug, waiting.outcomes, undefined)).toMatchObject({
    action: 'refuse',
    message: expect.stringMatching(/allowed values: review, slice/),
  })
})

test('docs-deviations closes either on a ruling or on a no-deviations artifact', () => {
  const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const step = parseWorkflowTree(collectWorkflowTree(repositoryRoot)).steps.find(
    ({ slug }) => slug === 'docs-deviations',
  )!
  const decide = (outcome: 'deviations' | 'no-deviations', evidence: ValidatedEvidence) =>
    decideFloorSatisfaction({
      floors: decideCloseFloors(step, outcome),
      evidence,
      enforcement: 'floors',
      finishing: false,
      openObligations: [],
    })

  expect(step).toMatchObject({
    outcomes: ['deviations', 'no-deviations'],
    outcomeFloors: { 'no-deviations': ['recorded-artifact'] },
  })
  expect(
    decide('no-deviations', {
      artifacts: [{ artifact: { ref: 'task:DEV-2490#comment:1', exists: true } }],
    }).action,
  ).toBe('allow')
  expect(decide('no-deviations', {}).action).toBe('refuse')
  expect(
    decide('deviations', {
      ruling: {
        id: 9,
        answered: true,
        answeredByOperator: true,
        boundToCursor: true,
        boundToStep: true,
      },
    }).action,
  ).toBe('allow')
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

test('task-open-with-notes requiring a pull request accepts only a merged pull request', () => {
  const requiredFloor = { ...taskOpenWithNotes, requirePullRequest: true }
  const task = {
    key: 'DEV-977',
    status: 'open',
    statusCategory: 'open',
    mergedPullRequest: false,
    trackerStates: {},
  }
  const note = {
    reference: `${PLATFORM_SLUG}#2817`,
    recordId: '00000000-0000-4000-8000-000000000014',
    label: `${PLATFORM_SLUG}#2817`,
    promotedTask: 'DEV-977',
    staleAt: null,
  }
  const result = (mergedPullRequest: boolean) =>
    decideFloorSatisfaction({
      floors: [requiredFloor],
      evidence: { task: { ...task, mergedPullRequest }, notes: [note] },
      workflowKey: 'DEV-977',
      enforcement: 'floors',
      finishing: false,
      openObligations: [],
    })

  expect(result(false)).toMatchObject({
    action: 'refuse',
    message: expect.stringContaining(
      'has no merged pull request; merge the pull request and record its link on the task',
    ),
  })
  expect(result(true)).toMatchObject({ action: 'allow' })
})

test('task-open-with-notes reports an unrecorded pull request with its recording remedy', () => {
  const result = decideFloorSatisfaction({
    floors: [{ ...taskOpenWithNotes, requirePullRequest: true }],
    evidence: {
      task: {
        key: 'DEV-977',
        status: 'open',
        statusCategory: 'open',
        mergedPullRequest: null,
        pullRequestUnavailable: {
          kind: 'unrecorded',
          reason: 'no pull request is recorded for task branch DEV-977-work',
          branch: 'DEV-977-work',
        },
        trackerStates: {},
      },
      notes: [
        {
          reference: `${PLATFORM_SLUG}#2817`,
          recordId: '00000000-0000-4000-8000-000000000014',
          label: `${PLATFORM_SLUG}#2817`,
          promotedTask: 'DEV-977',
          staleAt: null,
        },
      ],
    },
    workflowKey: 'DEV-977',
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
  })

  expect(result).toMatchObject({
    action: 'refuse',
    message: expect.stringContaining(
      `${PLATFORM_SLUG} tree branch landed DEV-977-work --pr <number>`,
    ),
  })
})

test('task-open-with-notes reports an unreadable pull request with its retry remedy', () => {
  const result = decideFloorSatisfaction({
    floors: [{ ...taskOpenWithNotes, requirePullRequest: true }],
    evidence: {
      task: {
        key: 'DEV-977',
        status: 'open',
        statusCategory: 'open',
        mergedPullRequest: null,
        pullRequestUnavailable: { kind: 'read-error', reason: 'gh unavailable' },
        trackerStates: {},
      },
      notes: [
        {
          reference: `${PLATFORM_SLUG}#2817`,
          recordId: '00000000-0000-4000-8000-000000000014',
          label: `${PLATFORM_SLUG}#2817`,
          promotedTask: 'DEV-977',
          staleAt: null,
        },
      ],
    },
    workflowKey: 'DEV-977',
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
  })

  expect(result).toMatchObject({
    action: 'refuse',
    message: expect.stringContaining('gh unavailable; rerun the close when GitHub is reachable'),
  })
})
