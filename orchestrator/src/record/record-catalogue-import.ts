// concern: record-catalogue-import
/** Atomically imports complete catalogue snapshots without changing matched hosted rows. */
import { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import type { RecordCatalogueImportResult, RecordLensImportInput } from './record-lens-contract.ts'
import type { RecordPortImportInput } from './record-port-contract.ts'
import type { RecordWorkflowImportInput } from './record-workflow-contract.ts'

type Tenant = { url: string } & TenantPrincipal
type Result = RecordCatalogueImportResult
const text = (value: unknown) => String(value)
const empty = (): Result => ({ inserted: 0, alreadyPresent: 0, skipped: [] })

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
    for (const row of input.lens) {
      const existing =
        await tx`SELECT id FROM lens WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR key=${row.key}) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
      const id = foundId(existing)
      if (id) result.alreadyPresent++
      else {
        await tx`INSERT INTO lens (id,space_id,key,title,question,excludes,slots,version,enabled,requires_execution,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.key},${row.title},${row.question},${row.excludes},${row.slots},${row.version},${row.enabled},${row.requiresExecution},${row.updatedAt}::timestamptz)`
        result.inserted++
      }
      lenses.set(row.id, id ?? row.id)
    }
    for (const row of input.lens_revision) {
      const lensId = lenses.get(row.lensId)
      if (!lensId) {
        result.skipped.push({ id: row.id, reason: `lens ${row.lensId} is absent` })
        continue
      }
      const existing =
        await tx`SELECT id FROM lens_revision WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (lens_id=${lensId}::uuid AND version=${row.version})) LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO lens_revision (id,space_id,lens_id,version,prior_body,reason,session_id,at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${lensId}::uuid,${row.version},${row.priorBody},${row.reason},${row.sessionId},${row.at}::timestamptz)`
        result.inserted++
      }
    }
    for (const row of input.lens_profile) {
      const lensId = lenses.get(row.lensId)
      if (!lensId) {
        result.skipped.push({ id: row.id, reason: `lens ${row.lensId} is absent` })
        continue
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
    }
    for (const row of input.lens_profile_revision) {
      const profileId = profiles.get(row.profileId)
      if (!profileId) {
        result.skipped.push({ id: row.id, reason: `profile ${row.profileId} is absent` })
        continue
      }
      const existing =
        await tx`SELECT id FROM lens_profile_revision WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (profile_id=${profileId}::uuid AND version=${row.version})) LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO lens_profile_revision (id,space_id,profile_id,version,prior_body,reason,session_id,at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${profileId}::uuid,${row.version},${row.priorBody},${row.reason},${row.sessionId},${row.at}::timestamptz)`
        result.inserted++
      }
    }
    for (const row of input.project_lens_profile) {
      const lensId = row.lensId ? lenses.get(row.lensId) : null
      if (row.lensId && !lensId) {
        result.skipped.push({ id: row.id, reason: `lens ${row.lensId} is absent` })
        continue
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
    }
    for (const row of input.project_lens_profile_revision) {
      const selectionId = selections.get(row.selectionId)
      if (!selectionId) {
        result.skipped.push({ id: row.id, reason: `selection ${row.selectionId} is absent` })
        continue
      }
      const existing =
        await tx`SELECT id FROM project_lens_profile_revision WHERE space_id=${input.spaceId}::uuid AND id=${row.id}::uuid LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO project_lens_profile_revision (id,space_id,selection_id,prior_profile_name,prior_selected_version,reason,session_id,at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${selectionId}::uuid,${row.priorProfileName},${row.priorSelectedVersion},${row.reason},${row.sessionId},${row.at}::timestamptz)`
        result.inserted++
      }
    }
    return result
  })
}

export async function importRecordWorkflowCatalogue(input: Tenant & RecordWorkflowImportInput) {
  return tenant(input, async (tx) => {
    const result = empty()
    for (const kind of ['step_catalogue', 'workflow'] as const) {
      const owners = new Map<string, string>()
      for (const row of input[kind]) {
        const existing =
          kind === 'workflow'
            ? await tx`SELECT id FROM workflow WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR slug=${row.slug}) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
            : await tx`SELECT id FROM step_catalogue WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR slug=${row.slug}) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
        const id = foundId(existing)
        if (id) result.alreadyPresent++
        else if (kind === 'workflow') {
          await tx`INSERT INTO workflow (id,space_id,slug,created_at,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.slug},${row.createdAt}::timestamptz,${row.updatedAt}::timestamptz)`
          result.inserted++
        } else {
          await tx`INSERT INTO step_catalogue (id,space_id,slug,created_at,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.slug},${row.createdAt}::timestamptz,${row.updatedAt}::timestamptz)`
          result.inserted++
        }
        owners.set(row.id, id ?? row.id)
      }
      const versions = new Map<string, string>(),
        versionTable = `${kind}_version` as 'workflow_version' | 'step_catalogue_version'
      for (const row of input[versionTable]) {
        const ownerId = owners.get(row.ownerId)
        if (!ownerId) {
          result.skipped.push({ id: row.id, reason: `${kind} ${row.ownerId} is absent` })
          continue
        }
        const existing =
          kind === 'workflow'
            ? await tx`SELECT id FROM workflow_version WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (workflow_id=${ownerId}::uuid AND n=${row.n})) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
            : await tx`SELECT id FROM step_catalogue_version WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (catalogue_id=${ownerId}::uuid AND n=${row.n})) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
        const id = foundId(existing)
        if (id) result.alreadyPresent++
        else if (kind === 'workflow') {
          await tx`INSERT INTO workflow_version (id,space_id,workflow_id,n,status,definition,author,reason,created_at,promoted_at,retired_at,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${ownerId}::uuid,${row.n},${row.status},${row.definition},${row.author},${row.reason},${row.createdAt}::timestamptz,${row.promotedAt}::timestamptz,${row.retiredAt}::timestamptz,${row.updatedAt}::timestamptz)`
          result.inserted++
        } else {
          await tx`INSERT INTO step_catalogue_version (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,promoted_at,retired_at,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${ownerId}::uuid,${row.n},${row.status},${row.definition},${row.author},${row.reason},${row.createdAt}::timestamptz,${row.promotedAt}::timestamptz,${row.retiredAt}::timestamptz,${row.updatedAt}::timestamptz)`
          result.inserted++
        }
        versions.set(row.id, id ?? row.id)
      }
      const eventTable = `${kind}_event` as 'workflow_event' | 'step_catalogue_event'
      for (const row of input[eventTable]) {
        const versionId = versions.get(row.ownerVersionId)
        if (!versionId) {
          result.skipped.push({
            id: row.id,
            reason: `${versionTable} ${row.ownerVersionId} is absent`,
          })
          continue
        }
        const existing =
          kind === 'workflow'
            ? await tx`SELECT id FROM workflow_event WHERE space_id=${input.spaceId}::uuid AND id=${row.id}::uuid`
            : await tx`SELECT id FROM step_catalogue_event WHERE space_id=${input.spaceId}::uuid AND id=${row.id}::uuid`
        if (existing[0]) result.alreadyPresent++
        else if (kind === 'workflow') {
          await tx`INSERT INTO workflow_event (id,space_id,workflow_version_id,event,author,reason,session_id,at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${versionId}::uuid,${row.event},${row.author},${row.reason},${row.sessionId},${row.at}::timestamptz)`
          result.inserted++
        } else {
          await tx`INSERT INTO step_catalogue_event (id,space_id,catalogue_version_id,event,author,reason,session_id,at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${versionId}::uuid,${row.event},${row.author},${row.reason},${row.sessionId},${row.at}::timestamptz)`
          result.inserted++
        }
      }
    }
    return result
  })
}

export async function importRecordPortCatalogue(input: Tenant & RecordPortImportInput) {
  return tenant(input, async (tx) => {
    const result = empty(),
      pairs = new Map<string, string>(),
      refs = new Map<string, string>()
    for (const row of input.port_doctrine) {
      const existing =
        await tx`SELECT id FROM port_doctrine WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR number=${row.number}) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO port_doctrine (id,space_id,number,title,body,created_at,retired_at,version,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.number},${row.title},${row.body},${row.createdAt}::timestamptz,${row.retiredAt}::timestamptz,${row.version},${row.updatedAt}::timestamptz)`
        result.inserted++
      }
    }
    for (const row of input.port_pair) {
      const existing =
        await tx`SELECT id FROM port_pair WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (source_project_id=${row.sourceProjectId}::uuid AND target_project_id=${row.targetProjectId}::uuid)) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
      const id = foundId(existing)
      if (id) result.alreadyPresent++
      else {
        await tx`INSERT INTO port_pair (id,space_id,source_project_id,target_project_id,created_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.sourceProjectId}::uuid,${row.targetProjectId}::uuid,${row.createdAt}::timestamptz)`
        result.inserted++
      }
      pairs.set(row.id, id ?? row.id)
    }
    for (const row of input.port_baseline) {
      const pairId = pairs.get(row.pairId)
      if (!pairId) {
        result.skipped.push({ id: row.id, reason: `pair ${row.pairId} is absent` })
        continue
      }
      const existing =
        await tx`SELECT id FROM port_baseline WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR pair_id=${pairId}::uuid) LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO port_baseline (id,space_id,pair_id,source_commit,scanned_at,version,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${pairId}::uuid,${row.sourceCommit},${row.scannedAt}::timestamptz,${row.version},${row.updatedAt}::timestamptz)`
        result.inserted++
      }
    }
    for (const row of input.port_ref) {
      const existing =
        await tx`SELECT id FROM port_ref WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (target_project_id=${row.targetProjectId}::uuid AND task_key=${row.taskKey})) ORDER BY id=${row.id}::uuid DESC LIMIT 1`
      const id = foundId(existing)
      if (id) result.alreadyPresent++
      else {
        await tx`INSERT INTO port_ref (id,space_id,task_key,target_project_id,note,created_at,resolved_at,deleted_at,version,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${row.taskKey},${row.targetProjectId}::uuid,${row.note},${row.createdAt}::timestamptz,${row.resolvedAt}::timestamptz,${row.deletedAt}::timestamptz,${row.version},${row.updatedAt}::timestamptz)`
        result.inserted++
      }
      refs.set(row.id, id ?? row.id)
    }
    for (const row of input.port_ref_source) {
      const refId = refs.get(row.refId)
      if (!refId) {
        result.skipped.push({ id: row.id, reason: `ref ${row.refId} is absent` })
        continue
      }
      const existing =
        await tx`SELECT id FROM port_ref_source WHERE space_id=${input.spaceId}::uuid AND (id=${row.id}::uuid OR (ref_id=${refId}::uuid AND source_project_id=${row.sourceProjectId}::uuid)) LIMIT 1`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO port_ref_source (id,space_id,ref_id,source_project_id,commits,paths,note,deleted_at,updated_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${refId}::uuid,${row.sourceProjectId}::uuid,${row.commits},${row.paths},${row.note},${row.deletedAt}::timestamptz,${row.updatedAt}::timestamptz)`
        result.inserted++
      }
    }
    for (const row of input.port_skip) {
      const pairId = pairs.get(row.pairId)
      if (!pairId) {
        result.skipped.push({ id: row.id, reason: `pair ${row.pairId} is absent` })
        continue
      }
      const existing =
        await tx`SELECT id FROM port_skip WHERE space_id=${input.spaceId}::uuid AND id=${row.id}::uuid`
      if (existing[0]) result.alreadyPresent++
      else {
        await tx`INSERT INTO port_skip (id,space_id,pair_id,candidate,reason,skipped_at) VALUES (${row.id}::uuid,${input.spaceId}::uuid,${pairId}::uuid,${row.candidate},${row.reason},${row.skippedAt}::timestamptz)`
        result.inserted++
      }
    }
    return result
  })
}
