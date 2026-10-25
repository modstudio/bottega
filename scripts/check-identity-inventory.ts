#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { applyMigrations as applyHubMigrations } from '../hub/src/migrations.ts'
import * as noteClient from '../hub/src/note-client.ts'
import { createRecordClient } from '../hub/src/record-client.ts'
import * as reportClient from '../hub/src/report-client.ts'
import * as taskClient from '../hub/src/task-client.ts'
import { applyMigrations as applyOrchestratorMigrations } from '../orchestrator/src/database/migrations.ts'
import * as recordApiClientModule from '../orchestrator/src/record/record-api-client.ts'
import { recordApiClient } from '../orchestrator/src/record/record-api-client.ts'
import { recordLensClient } from '../orchestrator/src/record/record-api-client-lens.ts'
import { projectIdentityClient } from '../orchestrator/src/record/record-api-client-paths.ts'
import { recordPortClient } from '../orchestrator/src/record/record-api-client-port.ts'
import { recordWorkflowClient } from '../orchestrator/src/record/record-api-client-workflow.ts'
import { SNAPSHOT_KINDS } from '../orchestrator/src/record/record-snapshots.ts'
import { configClient } from '../shared/config-client.ts'
import {
  assertShrinkingKeyBaseline,
  classifyKeyInventory,
  hostedKeyTables,
  readSqliteKeyTables,
  sqliteSyncedSchemaFacts,
  syncedSourceRefusals,
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

const methodNames = (prefix: string, client: Record<string, unknown>) =>
  Object.entries(client)
    .filter(([, value]) => typeof value === 'function')
    .map(([method]) => `${prefix}.${method}`)
    .sort()
const stubRequest = async () => ({})
const stubFetch = async () =>
  new Response('{}', { headers: { 'content-type': 'application/json' } })
const methodInventory = [
  ...methodNames(
    'orchestrator.recordApiClient',
    recordApiClient(stubRequest) as Record<string, unknown>,
  ),
  ...methodNames('orchestrator.recordApiClientModule', recordApiClientModule),
  ...methodNames(
    'orchestrator.recordLensClient',
    recordLensClient(stubRequest) as Record<string, unknown>,
  ),
  ...methodNames(
    'orchestrator.recordPortClient',
    recordPortClient(stubRequest) as Record<string, unknown>,
  ),
  ...methodNames(
    'orchestrator.recordWorkflowClient',
    recordWorkflowClient(stubRequest) as Record<string, unknown>,
  ),
  ...methodNames(
    'orchestrator.projectIdentityClient',
    projectIdentityClient(stubRequest) as Record<string, unknown>,
  ),
  ...methodNames(
    'hub.recordClient',
    createRecordClient({ baseUrl: 'https://stub.invalid', headers: {}, fetch: stubFetch }),
  ),
  ...methodNames(
    'hub.configClient',
    configClient({ BOTTEGA_RECORD_API_URL: 'https://stub.invalid' }, stubFetch, 'stub-token'),
  ),
  ...methodNames('hub.taskClient', taskClient),
  ...methodNames('hub.noteClient', noteClient),
  ...methodNames('hub.reportClient', reportClient),
  ...SNAPSHOT_KINDS.map((kind) => `orchestrator.snapshot.${kind}`),
]

const orchestrator = new Database(':memory:')
const hub = new Database(':memory:')
try {
  applyOrchestratorMigrations(orchestrator)
  applyHubMigrations(hub, undefined, {
    machine_id: '01990000-0000-7000-8000-000000001214',
  })
  const orchestratorTables = readSqliteKeyTables(orchestrator)
  const hubTables = readSqliteKeyTables(hub)
  const syncedRefusals = syncedSourceRefusals(
    KEY_MANIFESTS.syncedSources,
    methodInventory,
    KEY_MANIFESTS.infrastructure,
    [
      ...sqliteSyncedSchemaFacts('orchestrator', orchestratorTables),
      ...sqliteSyncedSchemaFacts('hub', hubTables),
    ],
  )
  if (syncedRefusals.length) throw new Error(syncedRefusals.join('\n'))
  const inventories = {
    orchestrator: classifyKeyInventory('orchestrator', orchestratorTables, KEY_MANIFESTS),
    hub: classifyKeyInventory('hub', hubTables, KEY_MANIFESTS),
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
