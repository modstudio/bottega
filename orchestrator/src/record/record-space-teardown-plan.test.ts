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
  PROJECT_PURGE_EXCLUSIONS,
  PROJECT_PURGE_PLAN,
  RECORD_DELETE_APPEND_ONLY_PROJECT_ROWS,
  RECORD_DELETE_APPEND_ONLY_SPACE_ROWS,
  RECORD_DELETE_PROTECTED_SPACE_ROWS,
  readRecordDefinerCounts,
  SPACE_TEARDOWN_EXCLUSIONS,
  SPACE_TEARDOWN_PLAN,
  unclassifiedProjectTables,
  unclassifiedSpaceTables,
} from './record-space-teardown-plan.ts'

test('definer count reading refuses a missing declared column', () => {
  expect(() =>
    readRecordDefinerCounts(
      [{ first_count: 1 }],
      [
        { table: 'first', countColumn: 'first_count' },
        { table: 'missing', countColumn: 'missing_count' },
      ],
      'record_delete_fixture_rows',
    ),
  ).toThrow('record_delete_fixture_rows result is missing declared count column missing_count')
})

const policyReachesRole = (to: unknown, role: string) =>
  to === undefined || to === 'public' || to === role || (Array.isArray(to) && to.includes(role))
const hostedTables = new Map(
  HOSTED_RECORD_TABLES.map((table) => [getTableConfig(table).name, getTableConfig(table)]),
)
const plans = [
  { name: 'space teardown', plan: SPACE_TEARDOWN_PLAN, exclusions: SPACE_TEARDOWN_EXCLUSIONS },
  { name: 'project purge', plan: PROJECT_PURGE_PLAN, exclusions: PROJECT_PURGE_EXCLUSIONS },
] as const

test('every planned RLS teardown and purge table permits actor deletion', () => {
  const gaps = plans.flatMap(({ name, plan }) =>
    plan.flatMap(({ table }) => {
      const config = hostedTables.get(table)
      if (!config?.enableRLS) return []
      const permitsActorDelete = config.policies.some(
        (policy) =>
          (policy.for === 'delete' || policy.for === 'all') &&
          policyReachesRole(policy.to, RECORD_ACTOR_ROLE),
      )
      return permitsActorDelete ? [] : [`${name}: ${table}`]
    }),
  )
  expect(
    gaps,
    `RLS teardown tables without record_actor DELETE: ${gaps.join(', ')}; add an actor DELETE policy, or delete each table in a definer function and list it in the corresponding exclusions map`,
  ).toEqual([])
})

test('every definer-deleted RLS teardown and purge exclusion permits owner visibility and deletion', () => {
  const gaps = plans.flatMap(({ name, exclusions }) =>
    Object.entries(exclusions).flatMap(([table, exclusion]) => {
      if (exclusion.removedBy !== 'definer') return []
      const config = hostedTables.get(table)
      if (!config?.enableRLS) return []
      return (['select', 'delete'] as const).flatMap((command) => {
        const permitsOwnerCommand = config.policies.some(
          (policy) =>
            (policy.for === command || policy.for === 'all') &&
            policyReachesRole(policy.to, RECORD_OWNER_ROLE),
        )
        return permitsOwnerCommand ? [] : [`${name}: ${table} ${command.toUpperCase()}`]
      })
    }),
  )
  expect(
    gaps,
    `RLS teardown exclusions deleted by a definer function without required record_owner policies: ${gaps.join(', ')}; add the named record_owner SELECT or DELETE policy so the definer function can see and remove each row under FORCE ROW LEVEL SECURITY`,
  ).toEqual([])
})

test('every teardown exclusion names a hosted record table', () => {
  const gaps = plans.flatMap(({ name, exclusions }) =>
    Object.keys(exclusions).flatMap((table) =>
      hostedTables.has(table) ? [] : [`${name}: ${table}`],
    ),
  )
  expect(gaps, `teardown exclusions naming unknown hosted tables: ${gaps.join(', ')}`).toEqual([])
})

test('definer count declarations exactly cover definer-deleted exclusions', () => {
  const spaceDefinerTables: string[] = [
    ...new Set([
      ...RECORD_DELETE_APPEND_ONLY_SPACE_ROWS.map(({ table }) => table),
      ...RECORD_DELETE_PROTECTED_SPACE_ROWS.map(({ table }) => table),
    ]),
  ].sort()
  const purgeDefinerTables: string[] = RECORD_DELETE_APPEND_ONLY_PROJECT_ROWS.map(
    ({ table }) => table,
  ).sort()
  const excluded = (exclusions: Record<string, { removedBy: string }>) =>
    Object.entries(exclusions)
      .filter(([, value]) => value.removedBy === 'definer')
      .map(([table]) => table)
      .sort()
  expect(spaceDefinerTables).toEqual(excluded(SPACE_TEARDOWN_EXCLUSIONS))
  expect(purgeDefinerTables).toEqual(excluded(PROJECT_PURGE_EXCLUSIONS))
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
