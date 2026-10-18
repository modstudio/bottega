// concern: record-push-catalogues
/** Plans and performs the one-time null-space catalogue backfill. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { activeRecordSpace, effectiveProjectSpace } from '../project-space.ts'
import type { RecordApiClient, RecordRequestDestination } from './record-api-client.ts'
import { recordApiClient } from './record-api-client.ts'
import type { RecordLensImportInput } from './record-lens-contract.ts'
import type { RecordPortImportInput } from './record-port-contract.ts'
import { noActiveRecordSpaceRefusal } from './record-project-destination.ts'
import { syncRecord } from './record-sync.ts'
import type { RecordWorkflowImportInput } from './record-workflow-contract.ts'

type Presentation = { log(value: string): void }
type Plan = {
  lens: RecordLensImportInput
  workflow: RecordWorkflowImportInput
  ports: Map<string, RecordPortImportInput>
  skipped: Array<{ kind: string; id: string; reason: string }>
}
const iso = () => new Date().toISOString()
const rows = <T>(local: Database, sql: string) => local.query(sql).all() as T[]

function lensPlan(local: Database, activeSpaceId: string): RecordLensImportInput {
  const now = iso()
  return {
    lens: rows<Record<string, unknown>>(local, 'SELECT * FROM lens WHERE space_id IS NULL').map(
      (r) => ({
        id: String(r.record_id),
        spaceId: activeSpaceId,
        key: String(r.id),
        title: String(r.title),
        question: String(r.question),
        excludes: String(r.excludes),
        slots: String(r.slots),
        version: Number(r.version),
        enabled: Boolean(r.enabled),
        requiresExecution: Boolean(r.requires_execution),
        updatedAt: now,
      }),
    ),
    lens_revision: rows<Record<string, unknown>>(
      local,
      `SELECT r.*,l.record_id lens_record_id FROM lens_revision r JOIN lens l ON l.id=r.lens_id WHERE r.space_id IS NULL`,
    ).map((r) => ({
      id: String(r.record_id),
      spaceId: activeSpaceId,
      lensId: String(r.lens_record_id),
      version: Number(r.version),
      priorBody: String(r.prior_body),
      reason: String(r.reason),
      sessionId: r.session_id == null ? null : String(r.session_id),
      at: String(r.at),
    })),
    lens_profile: rows<Record<string, unknown>>(
      local,
      `SELECT p.*,l.record_id lens_record_id FROM lens_profile p JOIN lens l ON l.id=p.lens_id WHERE p.space_id IS NULL`,
    ).map((r) => ({
      id: String(r.record_id),
      spaceId: activeSpaceId,
      lensId: String(r.lens_record_id),
      axis: r.axis as 'framework' | 'architecture',
      name: String(r.name),
      version: Number(r.version),
      body: String(r.body),
      enabled: Boolean(r.enabled),
      updatedAt: now,
    })),
    lens_profile_revision: rows<Record<string, unknown>>(
      local,
      `SELECT r.*,p.record_id profile_record_id FROM lens_profile_revision r JOIN lens_profile p ON p.id=r.profile_id WHERE r.space_id IS NULL`,
    ).map((r) => ({
      id: String(r.record_id),
      spaceId: activeSpaceId,
      profileId: String(r.profile_record_id),
      version: Number(r.version),
      priorBody: String(r.prior_body),
      reason: String(r.reason),
      sessionId: r.session_id == null ? null : String(r.session_id),
      at: String(r.at),
    })),
    project_lens_profile: rows<Record<string, unknown>>(
      local,
      `SELECT s.*,p.record_id project_record_id,l.record_id lens_record_id FROM project_lens_profile s JOIN project p ON p.id=s.project_id LEFT JOIN lens l ON l.id=s.lens_id WHERE s.space_id IS NULL`,
    ).map((r) => ({
      id: String(r.record_id),
      spaceId: activeSpaceId,
      projectId: String(r.project_record_id),
      lensId: r.lens_record_id == null ? null : String(r.lens_record_id),
      axis: r.axis as 'framework' | 'architecture',
      profileName: String(r.profile_name),
      selectedVersion: r.selected_version == null ? null : Number(r.selected_version),
      selectionVersion: Number(r.selection_version),
      updatedAt: now,
    })),
    project_lens_profile_revision: rows<Record<string, unknown>>(
      local,
      `SELECT r.*,s.record_id selection_record_id FROM project_lens_profile_revision r JOIN project_lens_profile s ON s.id=r.selection_id WHERE r.space_id IS NULL`,
    ).map((r) => ({
      id: String(r.record_id),
      spaceId: activeSpaceId,
      selectionId: String(r.selection_record_id),
      priorProfileName: r.prior_profile_name == null ? null : String(r.prior_profile_name),
      priorSelectedVersion:
        r.prior_selected_version == null ? null : Number(r.prior_selected_version),
      reason: String(r.reason),
      sessionId: r.session_id == null ? null : String(r.session_id),
      at: String(r.at),
    })),
  }
}

function workflowPlan(local: Database, activeSpaceId: string): RecordWorkflowImportInput {
  const now = iso()
  const kind = (name: 'workflow' | 'step_catalogue') => {
    const foreign = name === 'workflow' ? 'workflow_id' : 'catalogue_id'
    const identities = rows<Record<string, unknown>>(
      local,
      `SELECT * FROM ${name} WHERE space_id IS NULL`,
    ).map((r) => ({
      id: String(r.record_id),
      spaceId: activeSpaceId,
      slug: String(r.slug),
      createdAt: String(r.created_at),
      updatedAt: now,
    }))
    const versions = rows<Record<string, unknown>>(
      local,
      `SELECT v.*,i.record_id owner_record_id FROM ${name}_version v JOIN ${name} i ON i.id=v.${foreign} WHERE v.space_id IS NULL`,
    ).map((r) => ({
      id: String(r.record_id),
      spaceId: activeSpaceId,
      ownerId: String(r.owner_record_id),
      n: Number(r.n),
      status: r.status as 'draft' | 'production' | 'retired',
      definition: String(r.definition),
      author: String(r.author),
      reason: String(r.reason),
      createdAt: String(r.created_at),
      promotedAt: r.promoted_at == null ? null : String(r.promoted_at),
      retiredAt: r.retired_at == null ? null : String(r.retired_at),
      updatedAt: now,
    }))
    const events = rows<Record<string, unknown>>(
      local,
      `SELECT e.*,v.record_id version_record_id FROM ${name}_event e JOIN ${name}_version v ON v.${foreign}=e.${foreign} AND v.n=e.version_n WHERE e.space_id IS NULL`,
    ).map((r) => ({
      id: String(r.record_id),
      spaceId: activeSpaceId,
      ownerVersionId: String(r.version_record_id),
      event: r.event as 'set' | 'fork' | 'import' | 'promote' | 'retire',
      author: String(r.author),
      reason: String(r.reason),
      sessionId: r.session_id == null ? null : String(r.session_id),
      at: String(r.at),
    }))
    return { identities, versions, events }
  }
  const step = kind('step_catalogue'),
    workflow = kind('workflow')
  return {
    step_catalogue: step.identities,
    step_catalogue_version: step.versions,
    step_catalogue_event: step.events,
    workflow: workflow.identities,
    workflow_version: workflow.versions,
    workflow_event: workflow.events,
  }
}

function emptyPort(): RecordPortImportInput {
  return {
    replace: false,
    port_doctrine: [],
    port_pair: [],
    port_baseline: [],
    port_ref: [],
    port_ref_source: [],
    port_skip: [],
  }
}

function portPlan(local: Database, activeSpaceId: string, skipped: Plan['skipped']) {
  const plans = new Map<string, RecordPortImportInput>(),
    active = emptyPort()
  plans.set(activeSpaceId, active)
  active.port_doctrine = rows<Record<string, unknown>>(
    local,
    'SELECT * FROM port_doctrine WHERE space_id IS NULL',
  ).map((r) => ({
    id: String(r.record_id),
    spaceId: activeSpaceId,
    number: Number(r.number),
    title: String(r.title),
    body: String(r.body),
    createdAt: String(r.created_at),
    retiredAt: r.retired_at == null ? null : String(r.retired_at),
    version: Number(r.version),
    updatedAt: String(r.updated_at ?? r.created_at),
  }))
  const pairSpace = new Map<string, string>(),
    refSpace = new Map<string, string>()
  for (const r of rows<Record<string, unknown>>(
    local,
    `SELECT pp.*,sp.name source_name,tp.name target_name,sp.record_id source_record_id,tp.record_id target_record_id FROM port_pair pp JOIN project sp ON sp.id=pp.source_project_id JOIN project tp ON tp.id=pp.target_project_id WHERE pp.space_id IS NULL`,
  )) {
    const source = effectiveProjectSpace(local, String(r.source_name)),
      target = effectiveProjectSpace(local, String(r.target_name))
    if (!source || !target || source !== target) {
      skipped.push({
        kind: 'port_pair',
        id: String(r.record_id),
        reason:
          !source || !target ? 'project has no hosted space' : 'projects route to different spaces',
      })
      continue
    }
    const plan = plans.get(target) ?? emptyPort()
    plans.set(target, plan)
    pairSpace.set(String(r.record_id), target)
    plan.port_pair.push({
      id: String(r.record_id),
      spaceId: target,
      sourceProjectId: String(r.source_record_id),
      targetProjectId: String(r.target_record_id),
      createdAt: String(r.created_at),
    })
  }
  for (const r of rows<Record<string, unknown>>(
    local,
    `SELECT b.*,p.record_id pair_record_id FROM port_baseline b JOIN port_pair p ON p.id=b.pair_id WHERE b.space_id IS NULL`,
  )) {
    const space = pairSpace.get(String(r.pair_record_id))
    if (!space) {
      skipped.push({ kind: 'port_baseline', id: String(r.record_id), reason: 'pair was skipped' })
      continue
    }
    plans
      .get(space)!
      .port_baseline.push({
        id: String(r.record_id),
        spaceId: space,
        pairId: String(r.pair_record_id),
        sourceCommit: r.source_commit == null ? null : String(r.source_commit),
        scannedAt: r.scanned_at == null ? null : String(r.scanned_at),
        version: Number(r.version),
        updatedAt: String(r.updated_at),
      })
  }
  for (const r of rows<Record<string, unknown>>(
    local,
    `SELECT pr.*,p.name project_name,p.record_id project_record_id FROM port_ref pr JOIN project p ON p.id=pr.target_project_id WHERE pr.space_id IS NULL`,
  )) {
    const space = effectiveProjectSpace(local, String(r.project_name))
    if (!space) {
      skipped.push({
        kind: 'port_ref',
        id: String(r.record_id),
        reason: 'project has no hosted space',
      })
      continue
    }
    const plan = plans.get(space) ?? emptyPort()
    plans.set(space, plan)
    refSpace.set(String(r.record_id), space)
    plan.port_ref.push({
      id: String(r.record_id),
      spaceId: space,
      taskKey: String(r.task_key),
      targetProjectId: String(r.project_record_id),
      note: String(r.note),
      createdAt: String(r.created_at),
      resolvedAt: r.resolved_at == null ? null : String(r.resolved_at),
      deletedAt: r.deleted_at == null ? null : String(r.deleted_at),
      version: Number(r.version),
      updatedAt: String(r.updated_at),
    })
  }
  for (const r of rows<Record<string, unknown>>(
    local,
    `SELECT s.*,r.record_id ref_record_id,p.record_id project_record_id FROM port_ref_source s JOIN port_ref r ON r.id=s.ref_id JOIN project p ON p.id=s.source_project_id WHERE s.space_id IS NULL`,
  )) {
    const space = refSpace.get(String(r.ref_record_id))
    if (!space) {
      skipped.push({ kind: 'port_ref_source', id: String(r.record_id), reason: 'ref was skipped' })
      continue
    }
    plans
      .get(space)!
      .port_ref_source.push({
        id: String(r.record_id),
        spaceId: space,
        refId: String(r.ref_record_id),
        sourceProjectId: String(r.project_record_id),
        commits: String(r.commits),
        paths: String(r.paths),
        note: String(r.note),
        deletedAt: r.deleted_at == null ? null : String(r.deleted_at),
        updatedAt: String(r.updated_at),
      })
  }
  for (const r of rows<Record<string, unknown>>(
    local,
    `SELECT s.*,p.record_id pair_record_id FROM port_skip s JOIN port_pair p ON p.id=s.pair_id WHERE s.space_id IS NULL`,
  )) {
    const space = pairSpace.get(String(r.pair_record_id))
    if (!space) {
      skipped.push({ kind: 'port_skip', id: String(r.record_id), reason: 'pair was skipped' })
      continue
    }
    plans
      .get(space)!
      .port_skip.push({
        id: String(r.record_id),
        spaceId: space,
        pairId: String(r.pair_record_id),
        candidate: String(r.candidate),
        reason: String(r.reason),
        skippedAt: String(r.skipped_at),
      })
  }
  return plans
}

export function planCataloguePush(local: Database, activeSpaceId: string): Plan {
  const skipped: Plan['skipped'] = []
  return {
    lens: lensPlan(local, activeSpaceId),
    workflow: workflowPlan(local, activeSpaceId),
    ports: portPlan(local, activeSpaceId, skipped),
    skipped,
  }
}

const count = (value: object) =>
  Object.values(value).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0)
export async function pushCataloguesCommand(
  options: { dryRun: boolean },
  presentation: Presentation,
  dependencies: { local?: Database; client?: RecordApiClient; sync?: typeof syncRecord } = {},
): Promise<void> {
  const local = dependencies.local ?? db(),
    client = dependencies.client ?? recordApiClient()
  const identity = await client.whoami(),
    active = identity.activeSpaceId ?? activeRecordSpace(local)
  if (!active) throw new Error(noActiveRecordSpaceRefusal())
  const plan = planCataloguePush(local, active)
  presentation.log(
    `lens: ${count(plan.lens)} planned; workflow: ${count(plan.workflow)} planned; port: ${[...plan.ports.values()].reduce((n, p) => n + count(p), 0)} planned; skipped: ${plan.skipped.length}`,
  )
  for (const skip of plan.skipped)
    presentation.log(`skipped ${skip.kind} ${skip.id}: ${skip.reason}`)
  if (options.dryRun) return
  if (!client.importLensCatalogue || !client.importWorkflowCatalogue || !client.importPortCatalogue)
    throw new Error(
      'record API does not support catalogue imports; deploy the matching record API, then retry',
    )
  const destination: RecordRequestDestination = { destinationSpaceId: active }
  const lens = await client.importLensCatalogue(plan.lens, destination),
    workflow = await client.importWorkflowCatalogue(plan.workflow, destination)
  presentation.log(
    `lens: inserted ${lens.inserted}, already present ${lens.alreadyPresent}, skipped ${lens.skipped.length}`,
  )
  presentation.log(
    `workflow: inserted ${workflow.inserted}, already present ${workflow.alreadyPresent}, skipped ${workflow.skipped.length}`,
  )
  for (const [spaceId, port] of plan.ports) {
    const result = await client.importPortCatalogue(port, { destinationSpaceId: spaceId })
    presentation.log(
      `port ${spaceId}: inserted ${result.inserted}, already present ${result.alreadyPresent}, skipped ${result.skipped.length}`,
    )
  }
  if (!client.sync) throw new Error('record API does not support sync; deploy the matching record API, then retry')
  await (dependencies.sync ?? syncRecord)({ local, client: client as RecordApiClient & { sync: NonNullable<RecordApiClient['sync']> } })
}
