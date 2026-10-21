// concern: record-catalogue-import
/** Atomically imports complete catalogue snapshots without changing matched hosted rows. */
import { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { BUILT_IN_WORKFLOW_AUTHOR } from '../workflow/workflow-built-ins.ts'
import type { RecordCatalogueImportResult } from './record-catalogue-contract.ts'
import { reconcileCatalogueHistory } from './record-catalogue-reconciliation.ts'
import type { RecordLensImportInput } from './record-lens-contract.ts'
import type { RecordPortImportInput } from './record-port-contract.ts'
import type {
  RecordWorkflowImportInput,
  RecordWorkflowImportResult,
} from './record-workflow-contract.ts'

type Tenant = { url: string } & TenantPrincipal
const text = (value: unknown) => String(value)
const empty = (): RecordCatalogueImportResult => ({ inserted: 0, alreadyPresent: 0, skipped: [] })
const emptyWorkflow = (): RecordWorkflowImportResult => ({ ...empty(), outcomes: [] })

async function forEachAsync<T>(
  values: readonly T[],
  use: (value: T) => Promise<void>,
): Promise<void> {
  for (const value of values) await use(value)
}

async function tenant<T>(input: Tenant, use: (tx: SQL) => Promise<T>): Promise<T> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      await tx`SELECT id FROM space WHERE id=${input.spaceId}::uuid FOR UPDATE`
      const dryRun = 'dryRun' in input && input.dryRun === true
      if (dryRun) await tx`SAVEPOINT catalogue_import_dry_run`
      const result = await use(tx)
      if (dryRun) {
        await tx`ROLLBACK TO SAVEPOINT catalogue_import_dry_run`
        await tx`RELEASE SAVEPOINT catalogue_import_dry_run`
      }
      return result
    })
  } finally {
    await client.close()
  }
}

function foundId(rows: Record<string, unknown>[]): string | null {
  return rows[0] ? text(rows[0].id) : null
}

export async function importRecordLensCatalogue(input: Tenant & RecordLensImportInput) {
  return tenant(input, async (tx) => {
    const result = empty(),
      lenses = new Map<string, string>(),
      profiles = new Map<string, string>(),
      selections = new Map<string, string>()
    await forEachAsync(input.lens, async (row) => {
      const existing =
        await tx`SELECT id FROM lens WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR key=${row.key}) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
      const id = foundId(existing)
      if (id) result.alreadyPresent++
      else {
        await tx`INSERT INTO lens (id,space_id,key,title,question,excludes,slots,version,enabled,requires_execution,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.key},${row.title},${row.question},${row.excludes},${row.slots},${row.version},${row.enabled},${row.requiresExecution},${row.updatedAt}::timestamptz)`
        result.inserted++
      }
      lenses.set(row.id, id ?? row.id)
    })
    await forEachAsync(input.lens_revision, async (row) => {
      const lensId = lenses.get(row.lensId)
      if (!lensId) {
        result.skipped.push({ id: row.id, reason: `lens ${row.lensId} is absent` })
        return
      }
      const existing =
        await tx`SELECT id FROM lens_revision WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (lens_id=${lensId}::uuid AND version=${row.version})) LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO lens_revision (id,space_id,lens_id,version,prior_body,reason,session_id,at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${lensId}::uuid,${row.version},${row.priorBody},${row.reason},${row.sessionId},${row.at}::timestamptz)`
        result.inserted++
      }
    })
    await forEachAsync(input.lens_profile, async (row) => {
      const lensId = lenses.get(row.lensId)
      if (!lensId) {
        result.skipped.push({ id: row.id, reason: `lens ${row.lensId} is absent` })
        return
      }
      const existing =
        await tx`SELECT id FROM lens_profile WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (lens_id=${lensId}::uuid AND axis=${row.axis} AND name=${row.name})) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
      const id = foundId(existing)
      if (id) result.alreadyPresent++
      else {
        await tx`INSERT INTO lens_profile (id,space_id,lens_id,axis,name,version,body,enabled,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${lensId}::uuid,${row.axis},${row.name},${row.version},${row.body},${row.enabled},${row.updatedAt}::timestamptz)`
        result.inserted++
      }
      profiles.set(row.id, id ?? row.id)
    })
    await forEachAsync(input.lens_profile_revision, async (row) => {
      const profileId = profiles.get(row.profileId)
      if (!profileId) {
        result.skipped.push({ id: row.id, reason: `profile ${row.profileId} is absent` })
        return
      }
      const existing =
        await tx`SELECT id FROM lens_profile_revision WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (profile_id=${profileId}::uuid AND version=${row.version})) LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO lens_profile_revision (id,space_id,profile_id,version,prior_body,reason,session_id,at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${profileId}::uuid,${row.version},${row.priorBody},${row.reason},${row.sessionId},${row.at}::timestamptz)`
        result.inserted++
      }
    })
    await forEachAsync(input.project_lens_profile, async (row) => {
      const lensId = row.lensId ? lenses.get(row.lensId) : null
      if (row.lensId && !lensId) {
        result.skipped.push({ id: row.id, reason: `lens ${row.lensId} is absent` })
        return
      }
      const existing = lensId
        ? await tx`SELECT id FROM project_lens_profile WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (project_id=${row.projectId}::uuid AND lens_id=${lensId}::uuid AND axis=${row.axis})) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
        : await tx`SELECT id FROM project_lens_profile WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (project_id=${row.projectId}::uuid AND lens_id IS NULL AND axis=${row.axis})) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
      const id = foundId(existing)
      if (id) result.alreadyPresent++
      else {
        await tx`INSERT INTO project_lens_profile (id,space_id,project_id,lens_id,axis,profile_name,selected_version,selection_version,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.projectId}::uuid,${lensId}::uuid,${row.axis},${row.profileName},${row.selectedVersion},${row.selectionVersion},${row.updatedAt}::timestamptz)`
        result.inserted++
      }
      selections.set(row.id, id ?? row.id)
    })
    await forEachAsync(input.project_lens_profile_revision, async (row) => {
      const selectionId = selections.get(row.selectionId)
      if (!selectionId) {
        result.skipped.push({ id: row.id, reason: `selection ${row.selectionId} is absent` })
        return
      }
      const existing =
        await tx`SELECT id FROM project_lens_profile_revision WHERE space_id=${input.spaceId}::uuid AND id=${row.id}::uuid LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO project_lens_profile_revision (id,space_id,selection_id,prior_profile_name,prior_selected_version,reason,session_id,at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${selectionId}::uuid,${row.priorProfileName},${row.priorSelectedVersion},${row.reason},${row.sessionId},${row.at}::timestamptz)`
        result.inserted++
      }
    })
    return result
  })
}

async function reconcileWorkflowVersions(
  tx: SQL,
  input: Tenant & RecordWorkflowImportInput,
  kind: 'workflow' | 'step_catalogue',
  owners: ReadonlyMap<string, string>,
  result: RecordWorkflowImportResult,
): Promise<Set<string>> {
  const versionTable = `${kind}_version` as 'workflow_version' | 'step_catalogue_version',
    keptVersions = new Set<string>()
  await forEachAsync(input[kind], async (owner) => {
    const ownerId = owners.get(owner.id),
      imported = input[versionTable].filter((row) => row.ownerId === owner.id)
    if (!ownerId) return
    const hosted: { id: unknown; author: unknown }[] =
      kind === 'workflow'
        ? await tx`SELECT id,author FROM workflow_version WHERE space_id=${input.spaceId}::uuid AND workflow_id=${ownerId}::uuid`
        : await tx`SELECT id,author FROM step_catalogue_version WHERE space_id=${input.spaceId}::uuid AND catalogue_id=${ownerId}::uuid`
    const decision = reconcileCatalogueHistory(
      imported.map(({ id, author }) => ({ id, author })),
      hosted.map((row) => ({ id: text(row.id), author: text(row.author) })),
      BUILT_IN_WORKFLOW_AUTHOR,
    )
    if (decision.action === 'replace-seed') {
      if (kind === 'workflow') {
        await tx`UPDATE workflow SET generation=generation+1,updated_at=now() WHERE space_id=${input.spaceId}::uuid AND id=${ownerId}::uuid`
        await tx`DELETE FROM workflow_event WHERE space_id=${input.spaceId}::uuid AND workflow_version_id IN (SELECT id FROM workflow_version WHERE space_id=${input.spaceId}::uuid AND workflow_id=${ownerId}::uuid)`
        await tx`DELETE FROM workflow_version WHERE space_id=${input.spaceId}::uuid AND workflow_id=${ownerId}::uuid`
      } else {
        await tx`UPDATE step_catalogue SET generation=generation+1,updated_at=now() WHERE space_id=${input.spaceId}::uuid AND id=${ownerId}::uuid`
        await tx`DELETE FROM step_catalogue_event WHERE space_id=${input.spaceId}::uuid AND catalogue_version_id IN (SELECT id FROM step_catalogue_version WHERE space_id=${input.spaceId}::uuid AND catalogue_id=${ownerId}::uuid)`
        await tx`DELETE FROM step_catalogue_version WHERE space_id=${input.spaceId}::uuid AND catalogue_id=${ownerId}::uuid`
      }
    } else if (decision.action === 'keep-hosted') {
      for (const row of imported) keptVersions.add(row.id)
    }
    if (decision.outcome)
      result.outcomes.push({ kind, slug: owner.slug, outcome: decision.outcome })
  })
  return keptVersions
}

type WorkflowVersionRow = RecordWorkflowImportInput['workflow_version'][number]
async function foundWorkflowVersion(
  tx: SQL,
  input: Tenant,
  kind: 'workflow' | 'step_catalogue',
  ownerId: string,
  row: WorkflowVersionRow,
): Promise<string | null> {
  const existing =
    kind === 'workflow'
      ? await tx`SELECT id FROM workflow_version WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (workflow_id=${ownerId}::uuid AND n=${row.n})) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
      : await tx`SELECT id FROM step_catalogue_version WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (catalogue_id=${ownerId}::uuid AND n=${row.n})) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
  return foundId(existing)
}

async function insertWorkflowVersion(
  tx: SQL,
  input: Tenant,
  kind: 'workflow' | 'step_catalogue',
  ownerId: string,
  row: WorkflowVersionRow,
): Promise<void> {
  if (kind === 'workflow')
    await tx`INSERT INTO workflow_version (id,space_id,workflow_id,n,status,definition,author,reason,created_at,promoted_at,retired_at,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${ownerId}::uuid,${row.n},${row.status},${row.definition},${row.author},${row.reason},${row.createdAt}::timestamptz,${row.promotedAt}::timestamptz,${row.retiredAt}::timestamptz,now())`
  else
    await tx`INSERT INTO step_catalogue_version (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,promoted_at,retired_at,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${ownerId}::uuid,${row.n},${row.status},${row.definition},${row.author},${row.reason},${row.createdAt}::timestamptz,${row.promotedAt}::timestamptz,${row.retiredAt}::timestamptz,now())`
}

async function importWorkflowVersions(
  tx: SQL,
  input: Tenant & RecordWorkflowImportInput,
  kind: 'workflow' | 'step_catalogue',
  owners: ReadonlyMap<string, string>,
  keptVersions: ReadonlySet<string>,
  result: RecordWorkflowImportResult,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>(),
    versionTable = `${kind}_version` as 'workflow_version' | 'step_catalogue_version'
  await forEachAsync(input[versionTable], async (row) => {
    if (keptVersions.has(row.id)) return
    const ownerId = owners.get(row.ownerId)
    if (!ownerId) {
      result.skipped.push({ id: row.id, reason: `${kind} ${row.ownerId} is absent` })
      return
    }
    const id = await foundWorkflowVersion(tx, input, kind, ownerId, row)
    if (id) result.alreadyPresent++
    else {
      await insertWorkflowVersion(tx, input, kind, ownerId, row)
      result.inserted++
    }
    versions.set(row.id, id ?? row.id)
  })
  return versions
}

export async function importRecordWorkflowCatalogue(input: Tenant & RecordWorkflowImportInput) {
  return tenant(input, async (tx) => {
    const result = emptyWorkflow()
    await forEachAsync(['step_catalogue', 'workflow'] as const, async (kind) => {
      const owners = new Map<string, string>()
      await forEachAsync(input[kind], async (row) => {
        const existing =
          kind === 'workflow'
            ? await tx`SELECT id FROM workflow WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR slug=${row.slug}) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
            : await tx`SELECT id FROM step_catalogue WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR slug=${row.slug}) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
        const id = foundId(existing)
        if (id) result.alreadyPresent++
        else if (kind === 'workflow') {
          await tx`INSERT INTO workflow (id,space_id,slug,created_at,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.slug},${row.createdAt}::timestamptz,now())`
          result.inserted++
        } else {
          await tx`INSERT INTO step_catalogue (id,space_id,slug,created_at,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.slug},${row.createdAt}::timestamptz,now())`
          result.inserted++
        }
        owners.set(row.id, id ?? row.id)
      })
      const keptVersions = await reconcileWorkflowVersions(tx, input, kind, owners, result)
      const versions = await importWorkflowVersions(tx, input, kind, owners, keptVersions, result),
        versionTable = `${kind}_version` as 'workflow_version' | 'step_catalogue_version'
      const eventTable = `${kind}_event` as 'workflow_event' | 'step_catalogue_event'
      await forEachAsync(input[eventTable], async (row) => {
        if (keptVersions.has(row.ownerVersionId)) return
        const versionId = versions.get(row.ownerVersionId)
        if (!versionId) {
          result.skipped.push({
            id: row.id,
            reason: `${versionTable} ${row.ownerVersionId} is absent`,
          })
          return
        }
        const existing =
          kind === 'workflow'
            ? await tx`SELECT id FROM workflow_event WHERE space_id=${input.spaceId}::uuid AND id=${row.id}::uuid`
            : await tx`SELECT id FROM step_catalogue_event WHERE space_id=${input.spaceId}::uuid AND id=${row.id}::uuid`
        if (existing[0]) result.alreadyPresent++
        else if (kind === 'workflow') {
          await tx`INSERT INTO workflow_event (id,space_id,workflow_version_id,event,author,reason,session_id,at,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${versionId}::uuid,${row.event},${row.author},${row.reason},${row.sessionId},${row.at}::timestamptz,now())`
          result.inserted++
        } else {
          await tx`INSERT INTO step_catalogue_event (id,space_id,catalogue_version_id,event,author,reason,session_id,at,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${versionId}::uuid,${row.event},${row.author},${row.reason},${row.sessionId},${row.at}::timestamptz,now())`
          result.inserted++
        }
      })
    })
    return result
  })
}

export async function importRecordPortCatalogue(input: Tenant & RecordPortImportInput) {
  return tenant(input, async (tx) => {
    const result = empty(),
      pairs = new Map<string, string>(),
      refs = new Map<string, string>()
    await forEachAsync(input.port_doctrine, async (row) => {
      const existing =
        await tx`SELECT id FROM port_doctrine WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR number=${row.number}) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO port_doctrine (id,space_id,number,title,body,created_at,retired_at,version,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.number},${row.title},${row.body},${row.createdAt}::timestamptz,${row.retiredAt}::timestamptz,${row.version},${row.updatedAt}::timestamptz)`
        result.inserted++
      }
    })
    await forEachAsync(input.port_pair, async (row) => {
      const existing =
        await tx`SELECT id FROM port_pair WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (source_project_id=${row.sourceProjectId}::uuid AND target_project_id=${row.targetProjectId}::uuid)) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
      const id = foundId(existing)
      if (id) result.alreadyPresent++
      else {
        await tx`INSERT INTO port_pair (id,space_id,source_project_id,target_project_id,created_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.sourceProjectId}::uuid,${row.targetProjectId}::uuid,${row.createdAt}::timestamptz)`
        result.inserted++
      }
      pairs.set(row.id, id ?? row.id)
    })
    await forEachAsync(input.port_baseline, async (row) => {
      const pairId = pairs.get(row.pairId)
      if (!pairId) {
        result.skipped.push({ id: row.id, reason: `pair ${row.pairId} is absent` })
        return
      }
      const existing =
        await tx`SELECT id FROM port_baseline WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR pair_id=${pairId}::uuid) LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO port_baseline (id,space_id,pair_id,source_commit,scanned_at,version,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${pairId}::uuid,${row.sourceCommit},${row.scannedAt}::timestamptz,${row.version},${row.updatedAt}::timestamptz)`
        result.inserted++
      }
    })
    await forEachAsync(input.port_ref, async (row) => {
      const existing =
        await tx`SELECT id FROM port_ref WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (target_project_id=${row.targetProjectId}::uuid AND task_key=${row.taskKey})) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
      const id = foundId(existing)
      if (id) result.alreadyPresent++
      else {
        await tx`INSERT INTO port_ref (id,space_id,task_key,target_project_id,note,created_at,resolved_at,deleted_at,version,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.taskKey},${row.targetProjectId}::uuid,${row.note},${row.createdAt}::timestamptz,${row.resolvedAt}::timestamptz,${row.deletedAt}::timestamptz,${row.version},${row.updatedAt}::timestamptz)`
        result.inserted++
      }
      refs.set(row.id, id ?? row.id)
    })
    await forEachAsync(input.port_ref_source, async (row) => {
      const refId = refs.get(row.refId)
      if (!refId) {
        result.skipped.push({ id: row.id, reason: `ref ${row.refId} is absent` })
        return
      }
      const existing =
        await tx`SELECT id FROM port_ref_source WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (ref_id=${refId}::uuid AND source_project_id=${row.sourceProjectId}::uuid)) LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO port_ref_source (id,space_id,ref_id,source_project_id,commits,paths,note,deleted_at,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${refId}::uuid,${row.sourceProjectId}::uuid,${row.commits},${row.paths},${row.note},${row.deletedAt}::timestamptz,${row.updatedAt}::timestamptz)`
        result.inserted++
      }
    })
    await forEachAsync(input.port_skip, async (row) => {
      const pairId = pairs.get(row.pairId)
      if (!pairId) {
        result.skipped.push({ id: row.id, reason: `pair ${row.pairId} is absent` })
        return
      }
      const existing =
        await tx`SELECT id FROM port_skip WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (pair_id=${pairId}::uuid AND candidate=${row.candidate})) LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO port_skip (id,space_id,pair_id,candidate,reason,skipped_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${pairId}::uuid,${row.candidate},${row.reason},${row.skippedAt}::timestamptz)`
        result.inserted++
      }
    })
    return result
  })
}
