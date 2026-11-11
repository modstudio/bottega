import { expect, test } from 'bun:test'
import { getTableConfig, pgTable, uuid } from 'drizzle-orm/pg-core'
import {
  project,
  RECORD_ACTOR_ROLE,
  RECORD_OWNER_ROLE,
  space,
} from '../../../shared/record/schema.ts'
import {
  deriveProjectPurgePlan,
  deriveSpaceTeardownPlan,
  HOSTED_RECORD_TABLES,
  SPACE_TEARDOWN_EXCLUSIONS,
  SPACE_TEARDOWN_PLAN,
  unclassifiedProjectTables,
  unclassifiedSpaceTables,
} from './record-space-teardown-plan.ts'

const policyReachesRole = (to: unknown, role: string) =>
  to === undefined || to === 'public' || to === role || (Array.isArray(to) && to.includes(role))

test('every planned RLS teardown table permits actor deletion', () => {
  const tables = new Map(
    HOSTED_RECORD_TABLES.map((table) => [getTableConfig(table).name, getTableConfig(table)]),
  )
  const gaps = SPACE_TEARDOWN_PLAN.flatMap(({ table }) => {
    const config = tables.get(table)
    if (!config?.enableRLS) return []
    const permitsActorDelete = config.policies.some((policy) => {
      if (policy.for !== 'delete' && policy.for !== 'all') return false
      return policyReachesRole(policy.to, RECORD_ACTOR_ROLE)
    })
    return permitsActorDelete ? [] : [table]
  })
  expect(
    gaps,
    `RLS teardown tables without record_actor DELETE: ${gaps.join(', ')}; add an actor DELETE policy, or delete each table in a definer function and list it in SPACE_TEARDOWN_EXCLUSIONS`,
  ).toEqual([])
})

test('every definer-deleted RLS teardown exclusion permits owner deletion', () => {
  const tables = new Map(
    HOSTED_RECORD_TABLES.map((table) => [getTableConfig(table).name, getTableConfig(table)]),
  )
  const gaps = Object.entries(SPACE_TEARDOWN_EXCLUSIONS).flatMap(([table, reason]) => {
    if (!reason.includes('deleted by') || !reason.includes('definer function')) return []
    const config = tables.get(table)
    if (!config?.enableRLS) return []
    const permitsOwnerDelete = config.policies.some(
      (policy) =>
        (policy.for === 'delete' || policy.for === 'all') &&
        policyReachesRole(policy.to, RECORD_OWNER_ROLE),
    )
    return permitsOwnerDelete ? [] : [table]
  })
  expect(
    gaps,
    `RLS teardown exclusions deleted by a definer function without record_owner DELETE: ${gaps.join(', ')}; add a record_owner DELETE policy so the definer function can remove each row under FORCE ROW LEVEL SECURITY`,
  ).toEqual([])
})

test('an unclassified space foreign key is refused', () => {
  const fixture = pgTable('fixture_space_child', {
    id: uuid().primaryKey(),
    spaceId: uuid('space_id').references(() => space.id),
  })
  expect(unclassifiedSpaceTables([space, fixture], [], {})).toEqual(['fixture_space_child'])
})
test('an unclassified project foreign key is refused', () => {
  const fixture = pgTable('fixture_project_child', {
    id: uuid().primaryKey(),
    projectId: uuid('project_id').references(() => project.id),
  })
  expect(unclassifiedProjectTables([project, fixture], [], {})).toEqual(['fixture_project_child'])
})
test('project purge owns set-null rows but leaves cascade rows to postgres', () => {
  const setNull = pgTable('fixture_set_null', {
    id: uuid().primaryKey(),
    projectId: uuid('project_id').references(() => project.id, { onDelete: 'set null' }),
  })
  const cascade = pgTable('fixture_cascade', {
    id: uuid().primaryKey(),
    projectId: uuid('project_id').references(() => project.id, { onDelete: 'cascade' }),
  })
  expect(deriveProjectPurgePlan([project, setNull, cascade], {}).map((step) => step.table)).toEqual(
    ['fixture_set_null'],
  )
})
test('a table without a space key that references an ordered table is refused', () => {
  const fixture = pgTable('fixture_project_child', {
    id: uuid().primaryKey(),
    projectId: uuid('project_id').references(() => project.id),
  })
  expect(unclassifiedSpaceTables([space, project, fixture], ['project'], {})).toEqual([
    'fixture_project_child',
  ])
})
test('the current reached tables retain their space ownership paths', () =>
  expect(
    SPACE_TEARDOWN_PLAN.filter((step) => step.reachedBy.every((reach) => reach.parent !== 'space')),
  ).toEqual([
    {
      table: 'board_message',
      reachedBy: [
        { columns: ['author_run_id'], parent: 'run', parentColumns: ['id'] },
        { columns: ['claim_id'], parent: 'board_claim', parentColumns: ['id'] },
      ],
    },
    {
      table: 'board_claim',
      reachedBy: [
        { columns: ['project_id'], parent: 'project', parentColumns: ['id'] },
        { columns: ['run_id'], parent: 'run', parentColumns: ['id'] },
      ],
    },
  ]))
test('a table discovered through one parent retains a later reach through another', () => {
  const direct = pgTable('fixture_direct', {
    id: uuid().primaryKey(),
    spaceId: uuid('space_id').references(() => space.id),
  })
  const middle = pgTable('fixture_middle', {
    id: uuid().primaryKey(),
    spaceId: uuid('space_id').references(() => space.id),
  })
  const later = pgTable('fixture_later', {
    id: uuid().primaryKey(),
    middleId: uuid('middle_id').references(() => middle.id),
  })
  const child = pgTable('fixture_multi_reach', {
    id: uuid().primaryKey(),
    directId: uuid('direct_id').references(() => direct.id),
    laterId: uuid('later_id').references(() => later.id),
  })

  expect(
    deriveSpaceTeardownPlan([space, direct, middle, later, child], {}).find(
      (step) => step.table === 'fixture_multi_reach',
    )?.reachedBy,
  ).toEqual([
    { columns: ['direct_id'], parent: 'fixture_direct', parentColumns: ['id'] },
    { columns: ['later_id'], parent: 'fixture_later', parentColumns: ['id'] },
  ])
})
