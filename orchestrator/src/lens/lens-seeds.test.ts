import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { seedLenses } from './lens-seeds.ts'

test('lens seeds are created only for an unbound store', () => {
  const unbound = new Database(':memory:')
  applyMigrations(unbound)
  unbound.exec('DELETE FROM lens_profile; DELETE FROM lens')
  seedLenses(unbound)
  expect(unbound.query('SELECT COUNT(*) n FROM lens WHERE space_id IS NULL').get()).toEqual({
    n: 6,
  })
  unbound.close()

  const bound = new Database(':memory:')
  applyMigrations(bound)
  bound.exec('DELETE FROM lens_profile; DELETE FROM lens')
  bound.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")
  seedLenses(bound)
  expect(bound.query('SELECT COUNT(*) n FROM lens').get()).toEqual({ n: 0 })
  bound.close()
})
