// concern: porting
/** Builds the per-space hosted bulk payloads for a legacy port import. */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { importDoc } from '../doc/docs.ts'
import type { Project } from '../project/projects.ts'
import { projects } from '../project/projects.ts'
import { activeRecordSpace, effectiveProjectSpace } from '../project-space.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import type { RecordPortImportInput } from '../record/record-port-contract.ts'
import { noActiveRecordSpaceRefusal } from '../record/record-project-destination.ts'
import { normalizePortBaselineScannedAt } from './porting-date.ts'
import { type ImportPlan, ImportRefusalError } from './porting-import-contract.ts'

type HostedImportPlan = Pick<
  ImportPlan,
  'pairs' | 'baselines' | 'skips' | 'refs' | 'doctrine' | 'docs' | 'refusals' | 'exclusions'
>

const emptyImport = (): RecordPortImportInput => ({
  dryRun: false,
  replace: false,
  port_doctrine: [],
  port_pair: [],
  port_baseline: [],
  port_ref: [],
  port_ref_source: [],
  port_skip: [],
})

function routedSpace(local: Database, project: Project | undefined): string | null {
  return project ? effectiveProjectSpace(local, project.name) : null
}

function pairRefusal(
  row: HostedImportPlan['pairs'][number],
  project: 'source' | 'target',
): ImportRefusalError {
  return new ImportRefusalError([
    {
      kind: 'refusal',
      what: 'hosted port pair',
      where: `${row.source} -> ${row.target}`,
      why: `the ${project} project has no hosted space`,
    },
  ])
}

function addDoctrine(
  payload: RecordPortImportInput,
  rows: HostedImportPlan['doctrine'],
  spaceId: string,
  now: string,
): void {
  for (const row of rows)
    payload.port_doctrine.push({
      id: newRecordId(),
      spaceId,
      number: row.number,
      title: row.title,
      body: row.body,
      createdAt: now,
      retiredAt: null,
      version: 1,
      updatedAt: now,
    })
}

function addHostedRef(
  local: Database,
  byId: Map<string, Project>,
  plan: HostedImportPlan,
  imports: Map<string, RecordPortImportInput>,
  row: HostedImportPlan['refs'][number],
  now: string,
): void {
  const spaceId = routedSpace(local, byId.get(row.targetProjectId))
  if (!spaceId)
    throw new ImportRefusalError([
      {
        kind: 'refusal',
        what: 'hosted port ref',
        where: row.taskKey,
        why: 'the target project has no hosted space',
      },
    ])
  const invalidSource = row.sources.find(
    (source) => !routedSpace(local, byId.get(source.source_project_record_id)),
  )
  if (invalidSource) {
    const source = byId.get(invalidSource.source_project_record_id)
    plan.exclusions.push({
      kind: 'exclusion',
      what: `hosted port ref ${row.taskKey}`,
      where: source?.name ?? invalidSource.source_project_record_id,
      why: 'a source project has no hosted space',
    })
    return
  }
  const payload = imports.get(spaceId) ?? emptyImport()
  imports.set(spaceId, payload)
  const id = newRecordId()
  payload.port_ref.push({
    id,
    spaceId,
    taskKey: row.taskKey,
    targetProjectId: row.targetProjectId,
    note: row.note,
    createdAt: now,
    resolvedAt: null,
    deletedAt: null,
    version: 1,
    updatedAt: now,
  })
  for (const source of row.sources)
    payload.port_ref_source.push({
      id: newRecordId(),
      spaceId,
      refId: id,
      sourceProjectId: source.source_project_record_id,
      commits: JSON.stringify(source.commits),
      paths: JSON.stringify(source.paths),
      note: source.note,
      deletedAt: null,
      updatedAt: now,
    })
}

export function buildHostedPortImports(
  local: Database,
  registered: Project[],
  plan: HostedImportPlan,
  active: string,
  now = new Date().toISOString(),
): Map<string, RecordPortImportInput> {
  const byId = new Map(registered.map((project) => [project.recordId, project]))
  const imports = new Map<string, RecordPortImportInput>([[active, emptyImport()]])
  const pairs = new Map<string, { id: string; spaceId: string }>()
  addDoctrine(imports.get(active)!, plan.doctrine, active, now)
  for (const row of plan.pairs) {
    const sourceSpace = routedSpace(local, byId.get(row.sourceId))
    const targetSpace = routedSpace(local, byId.get(row.targetId))
    if (!sourceSpace) throw pairRefusal(row, 'source')
    if (!targetSpace) throw pairRefusal(row, 'target')
    const payload = imports.get(targetSpace) ?? emptyImport()
    imports.set(targetSpace, payload)
    const id = newRecordId()
    pairs.set(`${row.source}->${row.target}`, { id, spaceId: targetSpace })
    payload.port_pair.push({
      id,
      spaceId: targetSpace,
      sourceProjectId: row.sourceId,
      targetProjectId: row.targetId,
      createdAt: now,
    })
  }
  for (const row of plan.baselines) {
    const pair = pairs.get(row.pairKey)
    if (!pair) continue
    imports.get(pair.spaceId)!.port_baseline.push({
      id: newRecordId(),
      spaceId: pair.spaceId,
      pairId: pair.id,
      sourceCommit: row.sourceCommit,
      scannedAt: normalizePortBaselineScannedAt(row.scannedAt),
      version: 1,
      updatedAt: now,
    })
  }
  for (const row of plan.skips) {
    const pair = pairs.get(row.pairKey)
    if (!pair) continue
    imports.get(pair.spaceId)!.port_skip.push({
      id: newRecordId(),
      spaceId: pair.spaceId,
      pairId: pair.id,
      candidate: row.candidate,
      reason: row.reason,
      skippedAt: now,
    })
  }
  for (const row of plan.refs) addHostedRef(local, byId, plan, imports, row, now)
  return imports
}

function fencedSourceArtifact(body: string): string {
  const longestTildeRun = Math.max(0, ...[...body.matchAll(/~+/g)].map((match) => match[0].length))
  const fence = '~'.repeat(Math.max(3, longestTildeRun + 1))
  return `${fence}text\n${body}\n${fence}\n`
}

export async function applyHostedPortImport(
  plan: HostedImportPlan,
  options: { sourceLabel?: string },
): Promise<void> {
  if (plan.refusals.length) throw new ImportRefusalError(plan.refusals)
  const local = db()
  const client = recordApiClient()
  const identity = await client.whoami()
  const active = identity.activeSpaceId ?? activeRecordSpace(local)
  if (!active) throw new Error(noActiveRecordSpaceRefusal())
  if (!client.importPortCatalogue)
    throw new Error(
      'record API does not support port imports; deploy the matching record API, then retry',
    )
  for (const [spaceId, payload] of buildHostedPortImports(local, projects(), plan, active))
    await client.importPortCatalogue(payload, { destinationSpaceId: spaceId })
  const context = {
    author: 'port-import',
    reason: `port import from ${options.sourceLabel ?? 'source corpus'}`,
  }
  for (const row of plan.docs)
    await importDoc({
      ...row,
      body: fencedSourceArtifact(row.body),
      delivery: 'demand',
      ...context,
    })
}
