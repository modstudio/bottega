#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { applyMigrations as applyHubMigrations } from '../hub/src/migrations.ts'
import {
  assertShrinkingKeyBaseline,
  classifyKeyInventory,
  formatIdentityInventory,
  orchestratorIdentityInventory,
  readSqliteKeyTables,
} from '../orchestrator/src/database/identity-inventory.ts'
import baseline from '../orchestrator/src/database/identity-key-baseline.json'
import {
  INFRASTRUCTURE_IDENTITIES,
  INTEGER_VALUES,
} from '../orchestrator/src/database/identity-key-manifest.ts'
import { applyMigrations as applyOrchestratorMigrations } from '../orchestrator/src/database/migrations.ts'
import { hostedKeyTables } from '../shared/record/identity-inventory.ts'

const orchestrator = new Database(':memory:')
const hub = new Database(':memory:')
try {
  applyOrchestratorMigrations(orchestrator)
  applyHubMigrations(hub, undefined, {
    machine_id: '01990000-0000-7000-8000-000000001214',
  })
  console.log(formatIdentityInventory(orchestratorIdentityInventory(orchestrator)))
  const inventories = {
    orchestrator: classifyKeyInventory(
      'orchestrator',
      readSqliteKeyTables(orchestrator),
      INTEGER_VALUES,
      INFRASTRUCTURE_IDENTITIES,
    ),
    hub: classifyKeyInventory(
      'hub',
      readSqliteKeyTables(hub),
      INTEGER_VALUES,
      INFRASTRUCTURE_IDENTITIES,
    ),
    hosted: classifyKeyInventory(
      'hosted',
      hostedKeyTables(),
      INTEGER_VALUES,
      INFRASTRUCTURE_IDENTITIES,
    ),
  }
  for (const store of ['orchestrator', 'hub', 'hosted'] as const) {
    assertShrinkingKeyBaseline(store, inventories[store].findings, baseline[store])
    console.log(`${store} key baseline (${inventories[store].findings.length})`)
  }
} finally {
  orchestrator.close()
  hub.close()
}
