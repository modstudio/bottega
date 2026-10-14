import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import {
  decideIdentityInventory,
  EXEMPT_TABLES,
  IDENTITY_BASELINE,
  orchestratorIdentityInventory,
} from './identity-inventory.ts'
import { applyMigrations } from './migrations.ts'

test('migrated tables are converted, exempt with reasons, or in the shrinking baseline', () => {
  const database = new Database(':memory:')
  try {
    applyMigrations(database)
    const inventory = orchestratorIdentityInventory(database)
    expect(inventory.converted.includes('run')).toBe(true)
    expect(inventory.converted.includes('question')).toBe(true)
    for (const table of [
      'blocker',
      'calibration',
      'canon_eval',
      'compared_pair',
      'duel',
      'run_carried_ruling',
      'run_checkpoint',
      'run_mutation_audit',
      'score',
      'gate_execution',
      'check_execution',
      'resource_claim',
      'question_delivery',
      'question_mutation_audit',
      'review_finding_amendment',
    ]) {
      expect(inventory.converted.includes(table)).toBe(true)
      expect(inventory.baseline.includes(table)).toBe(false)
    }
    expect(inventory.exempt).toHaveLength(EXEMPT_TABLES.length)
    expect(inventory.baseline).toHaveLength(IDENTITY_BASELINE.length)
  } finally {
    database.close()
  }
})

test('unknown and newly converted baseline tables are refused', () => {
  expect(() =>
    decideIdentityInventory([{ name: 'new_table', hasRequiredIdentity: false }], [], [], []),
  ).toThrow('add it to CONVERTED_TABLES, EXEMPT_TABLES with a reason, or IDENTITY_BASELINE')
  expect(() =>
    decideIdentityInventory([{ name: 'waiting', hasRequiredIdentity: true }], [], [], ['waiting']),
  ).toThrow('remove it from IDENTITY_BASELINE and add it to CONVERTED_TABLES')
})
