import { expect, test } from 'bun:test'
import { pgTable, uuid } from 'drizzle-orm/pg-core'
import { space } from './schema.ts'
import { spaceForeignKeyFacts, unclassifiedSpaceTables } from './space-teardown.ts'

test('an unclassified space foreign key is refused', () => {
  const fixture = pgTable('fixture_space_child', {
    id: uuid().primaryKey(),
    spaceId: uuid('space_id').references(() => space.id),
  })
  expect(unclassifiedSpaceTables(spaceForeignKeyFacts([space, fixture]), [], {})).toEqual([
    'fixture_space_child',
  ])
})
test('the current hosted schema is completely classified', () =>
  expect(unclassifiedSpaceTables(spaceForeignKeyFacts())).toEqual([]))
