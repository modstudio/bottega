import { expect, test } from 'bun:test'
import { pgTable, uuid } from 'drizzle-orm/pg-core'
import { project, space } from '../../../shared/record/schema.ts'
import {
  deriveSpaceTeardownPlan,
  SPACE_TEARDOWN_PLAN,
  unclassifiedSpaceTables,
} from './record-space-teardown-plan.ts'

test('an unclassified space foreign key is refused', () => {
  const fixture = pgTable('fixture_space_child', {
    id: uuid().primaryKey(),
    spaceId: uuid('space_id').references(() => space.id),
  })
  expect(unclassifiedSpaceTables([space, fixture], [], {})).toEqual(['fixture_space_child'])
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
