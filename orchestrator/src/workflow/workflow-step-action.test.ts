import { expect, test } from 'bun:test'
import { recordUnreachableRefusal } from '../../../shared/record-remedies.ts'
import { JOBS } from '../jobs/jobs.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'
import {
  decideStepDispatch,
  dispatchForStep,
  mergeForStep,
  type StepActionTarget,
  stepActionTarget,
} from './workflow-step-action.ts'

const target = (overrides: Partial<StepActionTarget> = {}): StepActionTarget => ({
  cursor: 17,
  cursorRecordId: 'cursor-record-17',
  workflowSlug: 'ship-task',
  stepSlug: 'implement',
  taskKey: 'DEV-2283',
  jobs: ['implement'],
  actions: [],
  ...overrides,
})

test('the action target selects the cursor handle and reads its composed ordinal', async () => {
  const d = database()
  const composition = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )
  const cursor = composition.cursor!
  const row = d
    .query<{ record_id: string }, [number]>('SELECT record_id FROM workflow_cursor WHERE number=?')
    .get(cursor.id)!
  expect(await stepActionTarget(cursor.id, d)).toEqual({
    cursor: cursor.id,
    cursorRecordId: row.record_id,
    workflowSlug: 'flow',
    stepSlug: composition.steps[0]!.slug,
    taskKey: args.key,
    jobs: composition.steps[0]!.jobs,
    actions: composition.steps[0]!.actions,
  })
})

test('a declared job dispatches with the cursor record and current step binding', async () => {
  const calls: unknown[][] = []
  await dispatchForStep(
    { cursor: 17, job: 'implement', argv: ['do', 'implement', 'Build it.'] },
    {
      read: async () => target(),
      dispatch: async (...args) => {
        calls.push(args)
      },
    },
  )
  expect(calls).toEqual([
    [
      ['do', 'implement', 'Build it.', '--key', 'DEV-2283'],
      { cursorRecordId: 'cursor-record-17', stepSlug: 'implement' },
    ],
  ])
})

test('an undeclared job refuses exactly and never dispatches', async () => {
  let calls = 0
  await expect(
    dispatchForStep(
      { cursor: 17, job: 'diagnose', argv: ['do', 'diagnose'] },
      {
        read: async () => target({ jobs: ['implement', 'issue-worker'] }),
        dispatch: async () => {
          calls += 1
        },
      },
    ),
  ).rejects.toThrow(
    'step implement of cursor 17 declares jobs: implement, issue-worker; diagnose is not one of them',
  )
  expect(calls).toBe(0)
})

test('a step declaring no jobs prints none in the exact refusal', async () => {
  await expect(
    dispatchForStep(
      { cursor: 17, job: 'diagnose', argv: ['do', 'diagnose'] },
      { read: async () => target({ jobs: [] }), dispatch: async () => {} },
    ),
  ).rejects.toThrow('step implement of cursor 17 declares jobs: none; diagnose is not one of them')
})

test('an unreachable current-step read propagates its refusal and starts nothing', async () => {
  const refusal = recordUnreachableRefusal('https://record.test', 'connection refused', 'probe')
  let dispatches = 0
  await expect(
    dispatchForStep(
      { cursor: 17, job: 'implement', argv: ['do', 'implement'] },
      {
        read: async () => {
          throw new Error(refusal)
        },
        dispatch: async () => {
          dispatches += 1
        },
      },
    ),
  ).rejects.toThrow(refusal)
  expect(dispatches).toBe(0)
})

test('the pure dispatch decision accepts a keyless explore lookup without a key', () => {
  expect(
    decideStepDispatch({
      cursor: 17,
      taskKey: '',
      workflowSlug: 'explore',
      stepSlug: 'investigate',
      stepJobs: ['understand'],
      job: JOBS.understand!,
    }),
  ).toEqual({ action: 'dispatch-without-key' })
})

test('the pure dispatch decision refuses a keyless writer with the task remedy before step membership', () => {
  expect(
    decideStepDispatch({
      cursor: 17,
      taskKey: '',
      workflowSlug: 'explore',
      stepSlug: 'act',
      stepJobs: [],
      job: JOBS.implement!,
    }),
  ).toEqual({
    action: 'refuse',
    reason:
      'workflow explore cursor 17 has no task key, and implement writes the repository; ' +
      'compose plan-task (or take up a task), then dispatch from that keyed cursor',
  })
})

test('the pure dispatch decision preserves a keyed cursor key', () => {
  expect(
    decideStepDispatch({
      cursor: 17,
      taskKey: 'DEV-2289',
      workflowSlug: 'ship-task',
      stepSlug: 'implement',
      stepJobs: ['implement'],
      job: JOBS.implement!,
    }),
  ).toEqual({ action: 'dispatch-with-key', key: 'DEV-2289' })
})

test('the pure dispatch decision refuses a keyless lookup missing from the step', () => {
  expect(
    decideStepDispatch({
      cursor: 17,
      taskKey: '',
      workflowSlug: 'explore',
      stepSlug: 'investigate',
      stepJobs: ['understand'],
      job: JOBS.diagnose!,
    }),
  ).toEqual({
    action: 'refuse',
    reason: 'step investigate of cursor 17 declares jobs: understand; diagnose is not one of them',
  })
})

test('a keyless lookup dispatch preserves argv and the cursor step binding', async () => {
  const calls: unknown[][] = []
  await dispatchForStep(
    { cursor: 17, job: 'understand', argv: ['do', 'understand', 'Inspect it.'] },
    {
      read: async () =>
        target({
          taskKey: '',
          workflowSlug: 'explore',
          stepSlug: 'investigate',
          jobs: ['understand'],
        }),
      dispatch: async (...args) => {
        calls.push(args)
      },
    },
  )
  expect(calls).toEqual([
    [
      ['do', 'understand', 'Inspect it.'],
      { cursorRecordId: 'cursor-record-17', stepSlug: 'investigate' },
    ],
  ])
})

test('land refuses an undeclared action exactly and never calls its PR service', async () => {
  let merges = 0
  await expect(
    mergeForStep(
      { cursor: 17, args: ['42', { cwd: '/tree' }] },
      {
        read: async () => target({ actions: ['pr-create'] }),
        merge: async () => {
          merges += 1
          throw new Error('must not merge')
        },
      },
    ),
  ).rejects.toThrow(
    'step implement of cursor 17 declares actions: pr-create; pr-merge is not one of them',
  )
  expect(merges).toBe(0)
})
