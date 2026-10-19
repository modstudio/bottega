import { expect, test } from 'bun:test'
import {
  type CatalogueVersionMetadata,
  reconcileCatalogueHistory,
} from './record-catalogue-import.ts'

const version = (id: string, author: string): CatalogueVersionMetadata => ({ id, author })

test('unchanged when the imported history is already hosted', () => {
  expect(
    reconcileCatalogueHistory([version('same', 'machine')], [version('same', 'seed')], 'seed'),
  ).toEqual({ action: 'unchanged', outcome: null })
})

test('imports normally when hosted history is empty', () => {
  expect(reconcileCatalogueHistory([version('local', 'machine')], [], 'seed')).toEqual({
    action: 'unchanged',
    outcome: null,
  })
})

test('replaces a history written entirely by the seeder', () => {
  expect(
    reconcileCatalogueHistory([version('local', 'machine')], [version('seed', 'seed')], 'seed'),
  ).toEqual({ action: 'replace-seed', outcome: 'replaced seeded built-in' })
})

test('keeps the complete hosted history when any version is person-authored', () => {
  expect(
    reconcileCatalogueHistory(
      [version('local', 'machine')],
      [version('seed', 'seed'), version('person', 'person')],
      'seed',
    ),
  ).toEqual({
    action: 'keep-hosted',
    outcome: 'kept hosted history; local history not imported',
  })
})
