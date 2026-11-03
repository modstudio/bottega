import { expect, test } from 'bun:test'
import { ownedEvidenceLookup } from './record-sync-evidence-lookup.ts'

const input = {
  id: 'record-id',
  spaceId: 'space-id',
  machineId: 'machine-id',
  userId: 'user-id',
  suffix: 'FOR UPDATE',
  scope: 'machine' as const,
}

/** Every `$n` the statement references, as numbers. */
const placeholders = (text: string) =>
  [...new Set([...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort()

test('a lookup passes exactly the parameters its statement references', () => {
  for (const table of ['run', 'review', 'question', 'landing', 'test_flake']) {
    const lookup = ownedEvidenceLookup({ ...input, table })
    expect(placeholders(lookup.text)).toEqual(lookup.values.map((_, index) => index + 1))
  }
})

test('space-principal lookup accepts any machine owned by the principal', () => {
  const lookup = ownedEvidenceLookup({
    ...input,
    table: 'task_flow_stage',
    scope: 'space-principal',
  })
  expect(lookup.text).toContain('owner_machine.id=evidence.opened_machine_id')
  expect(lookup.values).toEqual(['record-id', 'space-id', 'user-id'])
})

test('only a run lookup is bound to the starting user', () => {
  expect(ownedEvidenceLookup({ ...input, table: 'run' }).values).toEqual([
    'record-id',
    'space-id',
    'machine-id',
    'user-id',
  ])
  expect(ownedEvidenceLookup({ ...input, table: 'review' }).values).toEqual([
    'record-id',
    'space-id',
    'machine-id',
  ])
})
