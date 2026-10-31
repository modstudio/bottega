#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { applyMigrations as applyHubMigrations } from '../hub/src/migrations.ts'
import * as noteClient from '../hub/src/note-client.ts'
import { PUSHABLE_HUB_CHANGE_TABLES } from '../hub/src/push-contract.ts'
import { createRecordClient } from '../hub/src/record-client.ts'
import * as reportClient from '../hub/src/report-client.ts'
import * as taskClient from '../hub/src/task-client.ts'
import { applyMigrations as applyOrchestratorMigrations } from '../orchestrator/src/database/migrations.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../orchestrator/src/record/outbox-payload-contracts.ts'
import * as recordApiClientModule from '../orchestrator/src/record/record-api-client.ts'
import { recordApiClient } from '../orchestrator/src/record/record-api-client.ts'
import { recordLensClient } from '../orchestrator/src/record/record-api-client-lens.ts'
import { projectIdentityClient } from '../orchestrator/src/record/record-api-client-paths.ts'
import { recordPortClient } from '../orchestrator/src/record/record-api-client-port.ts'
import { recordWorkflowClient } from '../orchestrator/src/record/record-api-client-workflow.ts'
import { SNAPSHOT_KINDS } from '../orchestrator/src/record/record-snapshots.ts'
import { configClient } from '../shared/config-client.ts'
import { enumerateClientMethods } from './identity-client-enumeration.ts'
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

type OutboxSource = { source: string; reason: string }
const OUTBOX_KIND_SOURCES: Readonly<Record<keyof typeof OUTBOX_PAYLOAD_CONTRACTS, OutboxSource>> = {
  run: { source: 'run', reason: 'enqueued from run' },
  score: { source: 'score', reason: 'enqueued from score' },
  question: { source: 'question', reason: 'enqueued from question' },
  review: { source: 'review', reason: 'enqueued from review' },
  review_lens: { source: 'review_lens', reason: 'enqueued from review_lens' },
  review_finding: { source: 'review_finding', reason: 'enqueued from review_finding' },
  review_read: { source: 'review_read', reason: 'enqueued from review_read' },
  release: {
    source: 'release_ledger',
    reason: 'release is enqueued from release_ledger by release/release-outbox.ts',
  },
  landing: { source: 'landing', reason: 'enqueued from landing' },
  landing_override: { source: 'landing_override', reason: 'enqueued from landing_override' },
  landing_review_carry: {
    source: 'landing_review_carry',
    reason: 'enqueued from landing_review_carry',
  },
  landing_triage_snapshot: {
    source: 'landing_triage_snapshot',
    reason: 'enqueued from landing_triage_snapshot',
  },
  pull_request_ci: { source: 'pull_request_ci', reason: 'enqueued from pull_request_ci' },
  contention: { source: 'contention', reason: 'enqueued from contention' },
  test_flake: { source: 'test_flake', reason: 'enqueued from test_flake' },
  branch_disposal: { source: 'branch_disposal', reason: 'enqueued from branch_disposal' },
}

function runtimeSyncedSourceRefusals(): string[] {
  const syncSources = new Set(
    KEY_MANIFESTS.syncedSources['orchestrator.recordApiClient.sync']?.sources ?? [],
  )
  const pushSources = new Set(
    KEY_MANIFESTS.syncedSources['hub.taskClient.hostedPushChanges']?.sources ?? [],
  )
  return [
    ...Object.keys(OUTBOX_PAYLOAD_CONTRACTS).flatMap((kind) => {
      const mapping = OUTBOX_KIND_SOURCES[kind as keyof typeof OUTBOX_PAYLOAD_CONTRACTS]
      if (!mapping)
        return [`orchestrator.recordApiClient.sync: outbox kind ${kind} has no source table map`]
      return syncSources.has(mapping.source)
        ? []
        : [
            `orchestrator.recordApiClient.sync: outbox kind ${kind} source ${mapping.source} is not declared; remedy: add the source table (${mapping.reason})`,
          ]
    }),
    ...PUSHABLE_HUB_CHANGE_TABLES.flatMap((hostedTable) => {
      const localTable = hostedTable.replace(/^hub_/, '')
      return pushSources.has(localTable)
        ? []
        : [
            `hub.taskClient.hostedPushChanges: runtime push table ${hostedTable} has no declared local source ${localTable}; remedy: add the source table`,
          ]
    }),
  ].sort()
}

// These client methods are only enumerated and never called, so the stub value is never read.
const stubRequest = async <T>() => ({}) as T
const stubFetch = async () =>
  new Response('{}', { headers: { 'content-type': 'application/json' } })
const methodInventory = () => [
  ...enumerateClientMethods(
    'orchestrator.recordApiClient',
    recordApiClient(stubRequest) as Record<string, unknown>,
  ),
  ...enumerateClientMethods('orchestrator.recordApiClientModule', recordApiClientModule),
  ...enumerateClientMethods(
    'orchestrator.recordLensClient',
    recordLensClient(stubRequest) as Record<string, unknown>,
  ),
  ...enumerateClientMethods(
    'orchestrator.recordPortClient',
    recordPortClient(stubRequest) as Record<string, unknown>,
  ),
  ...enumerateClientMethods(
    'orchestrator.recordWorkflowClient',
    recordWorkflowClient(stubRequest) as Record<string, unknown>,
  ),
  ...enumerateClientMethods(
    'orchestrator.projectIdentityClient',
    projectIdentityClient(stubRequest) as Record<string, unknown>,
  ),
  ...enumerateClientMethods(
    'hub.recordClient',
    createRecordClient({ baseUrl: 'https://stub.invalid', headers: {}, fetch: stubFetch }),
  ),
  ...enumerateClientMethods(
    'hub.configClient',
    configClient({ BOTTEGA_RECORD_API_URL: 'https://stub.invalid' }, stubFetch, 'stub-token'),
  ),
  ...enumerateClientMethods('hub.taskClient', taskClient),
  ...enumerateClientMethods('hub.noteClient', noteClient),
  ...enumerateClientMethods('hub.reportClient', reportClient),
  ...SNAPSHOT_KINDS.map((kind) => `orchestrator.snapshot.${kind}`),
]

async function main(): Promise<void> {
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
    const orchestratorTables = readSqliteKeyTables(orchestrator)
    const hubTables = readSqliteKeyTables(hub)
    const syncedRefusals = syncedSourceRefusals(
      KEY_MANIFESTS.syncedSources,
      methodInventory(),
      KEY_MANIFESTS.infrastructure,
      [
        ...sqliteSyncedSchemaFacts('orchestrator', orchestratorTables),
        ...sqliteSyncedSchemaFacts('hub', hubTables),
      ],
    )
    const refusals = [...syncedRefusals, ...runtimeSyncedSourceRefusals()]
    if (refusals.length) throw new Error(refusals.join('\n'))
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
}

if (import.meta.main) await main()
