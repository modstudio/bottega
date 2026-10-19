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

type HostedImportPlan = {
  pairs: { source: string; target: string; sourceId: string; targetId: string }[]
  baselines: { pairKey: string; sourceCommit: string | null; scannedAt: string | null }[]
  skips: { pairKey: string; candidate: string; reason: string }[]
  refs: {
    taskKey: string
    targetProjectId: string
    note: string
    sources: {
      source_project_record_id: string
      commits: string[]
      paths: string[]
      note: string
    }[]
  }[]
  doctrine: { number: number; title: string; body: string }[]
  docs: { scope: string; subject: string | null; slug: string; title: string; body: string }[]
  refusals: HostedImportRefusal[]
}
type HostedImportRefusal = {
  kind: 'refusal'
  what: string
  where: string
  why: string
  value?: string
}

export class ImportRefusalError extends Error {
  public refusals: HostedImportRefusal[]

  constructor(refusals: HostedImportRefusal[]) {
    super(`port import refused with ${refusals.length} refusal(s)`)
    this.refusals = refusals
  }
}

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

function pairRefusal(row: HostedImportPlan['pairs'][number], missing: boolean): ImportRefusalError {
  return new ImportRefusalError([
    {
      kind: 'refusal',
      what: 'hosted port pair',
      where: `${row.source} -> ${row.target}`,
      why: missing ? 'a project has no hosted space' : 'the projects route to different spaces',
    },
  ])
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
  for (const row of plan.doctrine)
    imports.get(active)!.port_doctrine.push({
      id: newRecordId(),
      spaceId: active,
      number: row.number,
      title: row.title,
      body: row.body,
      createdAt: now,
      retiredAt: null,
      version: 1,
      updatedAt: now,
    })
  for (const row of plan.pairs) {
    const sourceSpace = routedSpace(local, byId.get(row.sourceId))
    const targetSpace = routedSpace(local, byId.get(row.targetId))
    if (!sourceSpace || !targetSpace || sourceSpace !== targetSpace)
      throw pairRefusal(row, !sourceSpace || !targetSpace)
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
      scannedAt: row.scannedAt,
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
  for (const row of plan.refs) {
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
