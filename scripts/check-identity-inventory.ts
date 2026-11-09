#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { applyMigrations as applyHubMigrations } from '../hub/src/migrations.ts'
import * as noteClient from '../hub/src/note-client.ts'
import { createRecordClient } from '../hub/src/record-client.ts'
import * as reportClient from '../hub/src/report-client.ts'
import { hubTableLifecycles } from '../hub/src/storage-lifecycle.ts'
import * as taskClient from '../hub/src/task-client.ts'
import { applyMigrations as applyOrchestratorMigrations } from '../orchestrator/src/database/migrations.ts'
import { orchestratorTableLifecycles } from '../orchestrator/src/database/storage-lifecycle.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../orchestrator/src/record/outbox-payload-contracts.ts'
import * as recordApiClientModule from '../orchestrator/src/record/record-api-client.ts'
import { recordApiClient } from '../orchestrator/src/record/record-api-client.ts'
import { recordLensClient } from '../orchestrator/src/record/record-api-client-lens.ts'
import { projectIdentityClient } from '../orchestrator/src/record/record-api-client-paths.ts'
import { recordPortClient } from '../orchestrator/src/record/record-api-client-port.ts'
import { recordWorkflowClient } from '../orchestrator/src/record/record-api-client-workflow.ts'
import * as recordEmailVerificationClient from '../orchestrator/src/record/record-email-verification-client.ts'
import { SNAPSHOT_KINDS } from '../orchestrator/src/record/record-snapshots.ts'
import { startBoundedSync } from '../shared/bounded-process.ts'
import { configClient } from '../shared/config-client.ts'
import { inspectionGitEnv } from '../shared/git.ts'
import { hostedTableLifecycles } from '../shared/record/storage-lifecycle.ts'
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
import stateClassBaseline from './identity-state-class-baseline.json'
import { stateClassRefusals } from './identity-state-class-check.ts'
import {
  OUTBOX_KIND_SOURCES,
  PUSHABLE_HUB_TABLES,
  STATE_CLASS_OUTBOX_TABLES,
} from './identity-state-class-facts.ts'
import { HOSTED_WRITE_PATHS, hostedWritePathReport } from './identity-state-class-report.ts'
import { STATE_CLASSES } from './identity-state-classes.ts'
import { repositoryLifecycleSymbol, storageLifecycleRefusals } from './storage-lifecycle-check.ts'

type Baseline = Record<'orchestrator' | 'hub' | 'hosted', string[]>
type StateClassBaseline = { hostedOutbox: string[]; hostedCaches: string[] }

function baseFile<T>(base: string, path: string): T | null {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const result = startBoundedSync(
    ['git', '-C', root, '--no-optional-locks', 'show', `${base}:${path}`],
    { budget: 'git-plumbing', env: inspectionGitEnv() },
  )
  if (result.exitCode === 0) return JSON.parse(result.stdout.toString()) as T
  const missing = startBoundedSync(
    ['git', '-C', root, '--no-optional-locks', 'cat-file', '-e', `${base}^{commit}`],
    { budget: 'git-plumbing', env: inspectionGitEnv() },
  )
  if (missing.exitCode === 0) return null
  throw new Error(`identity inventory could not resolve base commit ${base}`)
}

function stateClassBaselineRefusals(
  current: StateClassBaseline,
  previous: StateClassBaseline | null,
): string[] {
  if (!previous) return []
  return (['hostedOutbox', 'hostedCaches'] as const).flatMap((field) => {
    const before = new Set(previous[field])
    return current[field]
      .filter((key) => !before.has(key))
      .map(
        (key) =>
          `state class baseline ${field} gained ${key}; remedy: remove the hosted outbox or cache instead of widening the baseline`,
      )
  })
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
    ...PUSHABLE_HUB_TABLES.flatMap(({ hosted, local }) => {
      return pushSources.has(local)
        ? []
        : [
            `hub.taskClient.hostedPushChanges: runtime push table ${hosted} has no declared local source ${local}; remedy: add the source table`,
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
    'orchestrator.recordEmailVerificationClient',
    recordEmailVerificationClient,
  ),
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

function printStateClassReport(json: boolean): void {
  const report = hostedWritePathReport(STATE_CLASSES, STATE_CLASS_OUTBOX_TABLES)
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const path of HOSTED_WRITE_PATHS) {
    console.log(`${path}: ${report.counts[path]}`)
    for (const table of report.paths[path]) console.log(`  ${table}`)
  }
}

async function main(): Promise<void> {
  if (Bun.argv.includes('--report-state-classes')) {
    printStateClassReport(Bun.argv.includes('--json'))
    return
  }
  const base = Bun.argv.find((argument) => argument.startsWith('--base='))?.slice(7)
  if (!base) throw new Error('usage: check-identity-inventory.ts --base=<commit>')
  const previousBaseline = baseFile<Baseline>(base, 'scripts/identity-key-baseline.json')
  const previousStateClassBaseline = baseFile<StateClassBaseline>(
    base,
    'scripts/identity-state-class-baseline.json',
  )
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
    const hostedTableInventory = await hostedKeyTables()
    const classRefusals = stateClassRefusals({
      tables: {
        orchestrator: orchestratorTables.map((table) => table.name),
        hub: hubTables.map((table) => table.name),
      },
      declarations: STATE_CLASSES,
      outboxTables: STATE_CLASS_OUTBOX_TABLES,
      pushableHubTables: PUSHABLE_HUB_TABLES,
      hostedTables: hostedTableInventory.map((table) => table.name),
      allowedHostedOutbox: stateClassBaseline.hostedOutbox,
      allowedHostedCaches: stateClassBaseline.hostedCaches,
    })
    const lifecycleRefusals = await storageLifecycleRefusals(
      {
        orchestrator: orchestratorTables.map((table) => ({
          name: table.name,
          columns: table.columns.map((column) => column.name),
        })),
        hub: hubTables.map((table) => ({
          name: table.name,
          columns: table.columns.map((column) => column.name),
        })),
        hosted: hostedTableInventory.map((table) => ({
          name: table.name,
          columns: table.columns.map((column) => column.name),
        })),
      },
      [...orchestratorTableLifecycles, ...hubTableLifecycles, ...hostedTableLifecycles],
      repositoryLifecycleSymbol,
    )
    const refusals = [
      ...syncedRefusals,
      ...runtimeSyncedSourceRefusals(),
      ...stateClassBaselineRefusals(stateClassBaseline, previousStateClassBaseline),
      ...classRefusals,
      ...lifecycleRefusals,
    ]
    if (refusals.length) throw new Error(refusals.join('\n'))
    const inventories = {
      orchestrator: classifyKeyInventory('orchestrator', orchestratorTables, KEY_MANIFESTS),
      hub: classifyKeyInventory('hub', hubTables, KEY_MANIFESTS),
      hosted: classifyKeyInventory('hosted', hostedTableInventory, KEY_MANIFESTS),
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
