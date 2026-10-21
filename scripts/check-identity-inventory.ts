#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { applyMigrations as applyHubMigrations } from '../hub/src/migrations.ts'
import { applyMigrations as applyOrchestratorMigrations } from '../orchestrator/src/database/migrations.ts'
import {
  assertShrinkingKeyBaseline,
  classifyKeyInventory,
  hostedKeyTables,
  readSqliteKeyTables,
} from './identity-inventory.ts'
import baseline from './identity-key-baseline.json'
import { KEY_MANIFESTS } from './identity-key-manifest.ts'

type Baseline = Record<'orchestrator' | 'hub' | 'hosted', string[]>

function baseBaseline(base: string): Baseline | null {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const result = Bun.spawnSync(
    [
      'git',
      '-C',
      root,
      '--no-optional-locks',
      'show',
      `${base}:scripts/identity-key-baseline.json`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  if (result.exitCode === 0) return JSON.parse(result.stdout.toString()) as Baseline
  const missing = Bun.spawnSync(
    ['git', '-C', root, '--no-optional-locks', 'cat-file', '-e', `${base}^{commit}`],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  if (missing.exitCode === 0) return null
  throw new Error(`identity inventory could not resolve base commit ${base}`)
}

const base = Bun.argv.find((argument) => argument.startsWith('--base='))?.slice(7)
if (!base) throw new Error('usage: check-identity-inventory.ts --base=<commit>')
const previousBaseline = baseBaseline(base)

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
    assertShrinkingKeyBaseline(
      store,
      inventories[store].findings,
      baseline[store],
      previousBaseline?.[store] ?? null,
    )
    console.log(
      `${previousBaseline ? `${store} key baseline` : 'initial identity baseline'}: ${inventories[store].findings.length} entries`,
    )
  }
} finally {
  orchestrator.close()
  hub.close()
}
