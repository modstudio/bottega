import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  compareIdentitySets,
  drainFailsAudit,
  planTaskPushAudit,
  repairDecisionFor,
  taskPushVerdict,
} from './task-push-plan.ts'

const spaceA = 'space-a'
const spaceB = 'space-b'
const task = 'hub_task' as const
const interval = 'hub_interval' as const
const note = 'hub_note' as const
const pulled = new Set<string>([
  'hub_task',
  'hub_task_comment',
  'hub_task_document',
  'hub_task_status_event',
  'hub_note',
  'hub_note_acknowledgement',
])

test('compareIdentitySets counts pending as in-flight and skips stuck from missing', () => {
  expect(
    compareIdentitySets(['a', 'b', 'c', 'd'], ['a', 'e'], new Set(['c']), new Set(['d'])),
  ).toEqual({
    both: 1,
    machineOnly: ['b'],
    hostedOnly: ['e'],
    inFlight: ['c'],
  })
})

test('planTaskPushAudit reports agreement, unroutable, stuck, and insert-if-absent repair', () => {
  const plan = planTaskPushAudit({
    spaces: [spaceA, spaceB],
    tables: [task, interval],
    machine: [
      { table: task, id: 'both', destinationSpaceId: spaceA },
      { table: task, id: 'missing', destinationSpaceId: spaceA },
      { table: task, id: 'pending', destinationSpaceId: spaceA },
      { table: task, id: 'stuck', destinationSpaceId: spaceA },
      { table: task, id: 'ghost', project: 'ghost', reason: 'unregistered-project' },
      { table: task, id: 'other', destinationSpaceId: spaceB },
      { table: interval, id: 'local-interval', destinationSpaceId: spaceA },
    ],
    hosted: [
      { table: task, spaceId: spaceA, ids: ['both', 'hosted-only'] },
      { table: task, spaceId: spaceB, ids: ['other'] },
      { table: interval, spaceId: spaceA, ids: ['foreign-interval'] },
      { table: interval, spaceId: spaceB, ids: [] },
    ],
    outbox: [
      { table: task, rowId: 'pending', quarantinedAt: null, quarantineReason: null },
      {
        table: task,
        rowId: 'stuck',
        quarantinedAt: '2026-10-12T12:00:00.000Z',
        quarantineReason: 'deleted on the hosted record',
      },
    ],
    pulledTables: pulled,
  })
  const tasksA = plan.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((row) => row.table === task)
  const intervalsA = plan.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((row) => row.table === interval)
  const tasksB = plan.spaces
    .find((space) => space.spaceId === spaceB)
    ?.tables.find((row) => row.table === task)
  expect(tasksA).toMatchObject({
    pulled: true,
    both: 1,
    machineOnly: ['missing'],
    hostedOnly: ['hosted-only'],
    inFlight: ['pending'],
  })
  expect(intervalsA).toMatchObject({
    pulled: false,
    machineOnly: ['local-interval'],
    hostedOnly: ['foreign-interval'],
  })
  expect(tasksB).toMatchObject({ both: 1, machineOnly: [], hostedOnly: [] })
  expect(plan.unroutable).toEqual([
    { project: 'ghost', reason: 'unregistered-project', table: task, ids: ['ghost'] },
  ])
  expect(plan.stuck).toEqual([{ table: task, id: 'stuck', reason: 'deleted on the hosted record' }])
  expect(plan.repair).toEqual([
    { table: task, id: 'missing', fields: [] },
    { table: interval, id: 'local-interval', fields: null },
  ])
  expect(repairDecisionFor('hub_task_comment')).toEqual({ repairable: true, fields: [] })
  expect(repairDecisionFor('hub_task_status_event')).toEqual({ repairable: true, fields: null })
  expect(taskPushVerdict(plan, null)).toBeFalse()
})

test('a machine-only note is unrepairable because its number must be assigned by the host', () => {
  const plan = planTaskPushAudit({
    spaces: [spaceA],
    tables: [note],
    machine: [{ table: note, id: 'local-note', destinationSpaceId: spaceA }],
    hosted: [{ table: note, spaceId: spaceA, ids: [] }],
    outbox: [],
    pulledTables: pulled,
  })
  expect(plan.repair).toEqual([])
  expect(plan.unrepairable).toEqual([
    {
      table: note,
      id: 'local-note',
      reason: 'the hosted record assigns note numbers, so a missing note cannot be created by push',
      remedy: `inspect with \`${PLATFORM_SLUG} note list --json\` and find record_id local-note. The machine has no command to create a note the hosted record lacks, so the choice is to file it again or drop the machine copy. Dropping the machine copy currently queues an update that the hosted record can only reject.`,
    },
  ])
  expect(taskPushVerdict(plan, { rejected: 0, quarantined: 0, waitingOnRouting: {} })).toBeFalse()
})

test('hosted-only evidence does not fail and pulled hosted-only does', () => {
  const evidence = planTaskPushAudit({
    spaces: [spaceA],
    tables: [interval],
    machine: [],
    hosted: [{ table: interval, spaceId: spaceA, ids: ['foreign'] }],
    outbox: [],
    pulledTables: pulled,
  })
  expect(evidence.spaces[0]!.tables[0]).toMatchObject({
    pulled: false,
    hostedOnly: ['foreign'],
    machineOnly: [],
  })
  expect(taskPushVerdict(evidence, null)).toBeTrue()
  const pulledHosted = planTaskPushAudit({
    spaces: [spaceA],
    tables: [task],
    machine: [],
    hosted: [{ table: task, spaceId: spaceA, ids: ['foreign'] }],
    outbox: [],
    pulledTables: pulled,
  })
  expect(taskPushVerdict(pulledHosted, null)).toBeFalse()
})

test('a quarantined row fails and a pending row does not', () => {
  const stuck = planTaskPushAudit({
    spaces: [spaceA],
    tables: [task],
    machine: [{ table: task, id: 'stuck', destinationSpaceId: spaceA }],
    hosted: [{ table: task, spaceId: spaceA, ids: [] }],
    outbox: [
      {
        table: task,
        rowId: 'stuck',
        quarantinedAt: '2026-10-12T12:00:00.000Z',
        quarantineReason: 'conflict',
      },
    ],
    pulledTables: pulled,
  })
  expect(stuck.stuck).toEqual([{ table: task, id: 'stuck', reason: 'conflict' }])
  expect(stuck.spaces[0]!.tables[0]!.inFlight).toEqual([])
  expect(stuck.spaces[0]!.tables[0]!.machineOnly).toEqual([])
  expect(taskPushVerdict(stuck, null)).toBeFalse()
  const pending = planTaskPushAudit({
    spaces: [spaceA],
    tables: [task],
    machine: [{ table: task, id: 'fly', destinationSpaceId: spaceA }],
    hosted: [{ table: task, spaceId: spaceA, ids: [] }],
    outbox: [{ table: task, rowId: 'fly', quarantinedAt: null, quarantineReason: null }],
    pulledTables: pulled,
  })
  expect(pending.spaces[0]!.tables[0]!.inFlight).toEqual(['fly'])
  expect(taskPushVerdict(pending, null)).toBeTrue()
})

test('repair verdict ignores queued machine-only and fails when drain leaves work', () => {
  const plan = planTaskPushAudit({
    spaces: [spaceA],
    tables: [task],
    machine: [{ table: task, id: 'missing', destinationSpaceId: spaceA }],
    hosted: [{ table: task, spaceId: spaceA, ids: [] }],
    outbox: [],
    pulledTables: pulled,
  })
  expect(taskPushVerdict(plan, null)).toBeFalse()
  expect(
    taskPushVerdict(plan, {
      rejected: 0,
      quarantined: 0,
      waitingOnRouting: {},
    }),
  ).toBeTrue()
  expect(
    drainFailsAudit({
      rejected: 1,
      quarantined: 0,
      waitingOnRouting: {},
    }),
  ).toBeTrue()
  expect(
    drainFailsAudit({
      rejected: 0,
      quarantined: 1,
      waitingOnRouting: {},
    }),
  ).toBeTrue()
  expect(
    drainFailsAudit({
      rejected: 0,
      quarantined: 0,
      waitingOnRouting: { 'unregistered-project': 1 },
    }),
  ).toBeTrue()
  expect(
    drainFailsAudit({
      rejected: 0,
      quarantined: 0,
      waitingOnRouting: {},
      waitingOnHostedHub: { hub_interval: 1 },
    }),
  ).toBeTrue()
  expect(
    drainFailsAudit({
      rejected: 0,
      quarantined: 0,
      waitingOnRouting: {},
      hostedReachable: false,
    }),
  ).toBeTrue()
  expect(taskPushVerdict(plan, { rejected: 1, quarantined: 0, waitingOnRouting: {} })).toBeFalse()
})
