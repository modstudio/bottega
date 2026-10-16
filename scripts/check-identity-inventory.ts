#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { applyMigrations as applyHubMigrations } from '../hub/src/migrations.ts'
import {
  assertShrinkingKeyBaseline,
  classifyKeyInventory,
  hostedKeyTables,
  readSqliteKeyTables,
} from './identity-inventory.ts'
import baseline from './identity-key-baseline.json'
import { KEY_MANIFESTS } from './identity-key-manifest.ts'
import { applyMigrations as applyOrchestratorMigrations } from '../orchestrator/src/database/migrations.ts'

const orchestrator = new Database(':memory:')
const hub = new Database(':memory:')
try {
  applyOrchestratorMigrations(orchestrator)
  applyHubMigrations(hub, undefined, {
    machine_id: '01990000-0000-7000-8000-000000001214',
  })
  const inventories = {
    orchestrator: classifyKeyInventory(
      'orchestrator',
      readSqliteKeyTables(orchestrator),
      KEY_MANIFESTS,
    ),
    hub: classifyKeyInventory('hub', readSqliteKeyTables(hub), KEY_MANIFESTS),
    hosted: classifyKeyInventory('hosted', await hostedKeyTables(), KEY_MANIFESTS),
  }
  for (const store of ['orchestrator', 'hub', 'hosted'] as const) {
    assertShrinkingKeyBaseline(store, inventories[store].findings, baseline[store])
    console.log(`${store} key baseline (${inventories[store].findings.length})`)
  }
} finally {
  orchestrator.close()
  hub.close()
}
