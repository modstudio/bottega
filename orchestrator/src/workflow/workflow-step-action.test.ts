import { expect, test } from 'bun:test'
import { recordUnreachableRefusal } from '../../../shared/record-remedies.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'
import {
  dispatchForStep,
  landForStep,
  type StepActionTarget,
  stepActionTarget,
} from './workflow-step-action.ts'

const target = (overrides: Partial<StepActionTarget> = {}): StepActionTarget => ({
  cursor: 17,
  cursorRecordId: 'cursor-record-17',
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

test('a keyless cursor refuses before dispatch', async () => {
  let dispatches = 0
  await expect(
    dispatchForStep(
      { cursor: 17, job: 'implement', argv: ['do', 'implement'] },
      {
        read: async () => target({ taskKey: '' }),
        dispatch: async () => {
          dispatches += 1
        },
      },
    ),
  ).rejects.toThrow('cursor 17 has no task key; workflow dispatch needs a keyed cursor')
  expect(dispatches).toBe(0)
})

test('land refuses an undeclared action exactly and never calls either PR service', async () => {
  let creates = 0
  let merges = 0
  await expect(
    landForStep(
      { action: 'merge', cursor: 17, args: ['42', { cwd: '/tree' }] },
      {
        read: async () => target({ actions: ['pr-create'] }),
        create: async () => {
          creates += 1
        },
        merge: async () => {
          merges += 1
          throw new Error('must not merge')
        },
      },
    ),
  ).rejects.toThrow(
    'step implement of cursor 17 declares actions: pr-create; pr-merge is not one of them',
  )
  expect({ creates, merges }).toEqual({ creates: 0, merges: 0 })
})

test('declared create and merge actions preserve the PR service arguments', async () => {
  const createCalls: unknown[][] = []
  const mergeCalls: unknown[][] = []
  const ports = {
    read: async () => target({ actions: ['pr-create', 'pr-merge'] }),
    create: async (...args: Parameters<Parameters<typeof landForStep>[1]['create']>) => {
      createCalls.push(args)
    },
    merge: async (...args: Parameters<Parameters<typeof landForStep>[1]['merge']>) => {
      mergeCalls.push(args)
    },
  }
  const createArgs: Parameters<typeof ports.create> = [
    ['--title', 'DEV-2283 title'],
    { cwd: '/tree', overrideTriage: 'approved', fromOperator: true },
  ]
  const mergeArgs: Parameters<typeof ports.merge> = [
    '42',
    { cwd: '/tree', releaseRequired: true, depth: 'hosted-api' },
  ]
  await landForStep({ action: 'create', cursor: 17, args: createArgs }, ports)
  await landForStep({ action: 'merge', cursor: 17, args: mergeArgs }, ports)
  expect(createCalls).toEqual([createArgs])
  expect(mergeCalls).toEqual([mergeArgs])
})
