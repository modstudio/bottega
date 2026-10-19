// concern: record-space-built-ins
/** Convergently installs the shared TypeScript built-ins into hosted spaces. */
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import {
  BUILT_IN_LENS_DEFAULT_PROFILE,
  BUILT_IN_LENS_SLOTS,
  BUILT_IN_LENSES,
} from '../lens/lens-built-ins.ts'
import {
  BUILT_IN_WORKFLOW_AUTHOR,
  builtInWorkflowCatalogue,
} from '../workflow/workflow-built-ins.ts'

type Tenant = { url: string } & TenantPrincipal
export type SpaceBuiltInsResult = { inserted: number; alreadyPresent: number }
async function forEachAsync<T>(
  values: readonly T[],
  use: (value: T) => Promise<void>,
): Promise<void> {
  for (const value of values) await use(value)
}

async function ensureInTransaction(tx: SQL, spaceId: string): Promise<SpaceBuiltInsResult> {
  const result = { inserted: 0, alreadyPresent: 0 }
  await tx`SELECT id FROM space WHERE id=${spaceId}::uuid FOR UPDATE`
  await forEachAsync(BUILT_IN_LENSES, async ([key, title, question, excludes]) => {
    let lenses = await tx`SELECT id FROM lens WHERE space_id=${spaceId}::uuid AND key=${key}`
    if (lenses[0]) result.alreadyPresent++
    else {
      const id = newRecordId()
      lenses = await tx`INSERT INTO lens
        (id,space_id,key,title,question,excludes,slots,version,enabled,requires_execution,updated_at)
        VALUES (${id}::uuid,${spaceId}::uuid,${key},${title},${question},${excludes},
          ${BUILT_IN_LENS_SLOTS},1,true,false,now()) RETURNING id`
      result.inserted++
    }
    const lensId = String(lenses[0]!.id)
    const profiles = await tx`SELECT id FROM lens_profile
      WHERE space_id=${spaceId}::uuid AND lens_id=${lensId}::uuid
        AND axis='framework' AND name='default'`
    if (profiles[0]) result.alreadyPresent++
    else {
      await tx`INSERT INTO lens_profile
        (id,space_id,lens_id,axis,name,version,body,enabled,updated_at)
        VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${lensId}::uuid,'framework','default',1,
          ${BUILT_IN_LENS_DEFAULT_PROFILE},true,now())`
      result.inserted++
    }
  })
  const builtIns = builtInWorkflowCatalogue()
  await forEachAsync(
    [
      { kind: 'step_catalogue' as const, ...builtIns.stepCatalogue },
      ...builtIns.workflows.map((item) => ({ kind: 'workflow' as const, ...item })),
    ],
    async (item) => {
      let owners =
        item.kind === 'workflow'
          ? await tx`SELECT id FROM workflow WHERE space_id=${spaceId}::uuid AND slug=${item.slug}`
          : await tx`SELECT id FROM step_catalogue WHERE space_id=${spaceId}::uuid AND slug=${item.slug}`
      if (owners[0]) result.alreadyPresent++
      else {
        const id = newRecordId()
        owners =
          item.kind === 'workflow'
            ? await tx`INSERT INTO workflow (id,space_id,slug,created_at,updated_at)
            VALUES (${id}::uuid,${spaceId}::uuid,${item.slug},now(),now()) RETURNING id`
            : await tx`INSERT INTO step_catalogue (id,space_id,slug,created_at,updated_at)
            VALUES (${id}::uuid,${spaceId}::uuid,${item.slug},now(),now()) RETURNING id`
        result.inserted++
      }
      const ownerId = String(owners[0]!.id)
      let versions =
        item.kind === 'workflow'
          ? await tx`SELECT id FROM workflow_version WHERE space_id=${spaceId}::uuid AND workflow_id=${ownerId}::uuid AND n=1`
          : await tx`SELECT id FROM step_catalogue_version WHERE space_id=${spaceId}::uuid AND catalogue_id=${ownerId}::uuid AND n=1`
      if (versions[0]) result.alreadyPresent++
      else {
        const id = newRecordId()
        versions =
          item.kind === 'workflow'
            ? await tx`INSERT INTO workflow_version
            (id,space_id,workflow_id,n,status,definition,author,reason,created_at,promoted_at,updated_at)
            VALUES (${id}::uuid,${spaceId}::uuid,${ownerId}::uuid,1,'production',${item.definition},
              ${BUILT_IN_WORKFLOW_AUTHOR},${item.reason},now(),now(),now()) RETURNING id`
            : await tx`INSERT INTO step_catalogue_version
            (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,promoted_at,updated_at)
            VALUES (${id}::uuid,${spaceId}::uuid,${ownerId}::uuid,1,'production',${item.definition},
              ${BUILT_IN_WORKFLOW_AUTHOR},${item.reason},now(),now(),now()) RETURNING id`
        result.inserted++
      }
      const versionId = String(versions[0]!.id)
      const events =
        item.kind === 'workflow'
          ? await tx`SELECT id FROM workflow_event WHERE space_id=${spaceId}::uuid AND workflow_version_id=${versionId}::uuid AND event='set'`
          : await tx`SELECT id FROM step_catalogue_event WHERE space_id=${spaceId}::uuid AND catalogue_version_id=${versionId}::uuid AND event='set'`
      if (events[0]) result.alreadyPresent++
      else if (item.kind === 'workflow') {
        await tx`INSERT INTO workflow_event
        (id,space_id,workflow_version_id,event,author,reason,at,updated_at)
        VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${versionId}::uuid,'set',
          ${BUILT_IN_WORKFLOW_AUTHOR},${item.reason},now(),now())`
        result.inserted++
      } else {
        await tx`INSERT INTO step_catalogue_event
        (id,space_id,catalogue_version_id,event,author,reason,at,updated_at)
        VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${versionId}::uuid,'set',
          ${BUILT_IN_WORKFLOW_AUTHOR},${item.reason},now(),now())`
        result.inserted++
      }
    },
  )
  return result
}

export async function ensureSpaceBuiltIns(input: Tenant): Promise<SpaceBuiltInsResult> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      return ensureInTransaction(tx, input.spaceId)
    })
  } finally {
    await client.close()
  }
}

/** The migration owner performs the release backfill because tenant RLS cannot enumerate spaces. */
export async function ensureAllSpaceBuiltIns(url: string): Promise<SpaceBuiltInsResult> {
  const client = new SQL(url)
  try {
    return await client.begin(async (tx) => {
      const tables = [
        'space',
        'lens',
        'lens_profile',
        'workflow',
        'workflow_version',
        'workflow_event',
        'step_catalogue',
        'step_catalogue_version',
        'step_catalogue_event',
      ]
      for (const table of tables)
        await tx.unsafe(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`)
      const total = { inserted: 0, alreadyPresent: 0 }
      await forEachAsync(
        (await tx`SELECT id FROM space ORDER BY id`) as { id: unknown }[],
        async (row) => {
          const result = await ensureInTransaction(tx, String(row.id))
          total.inserted += result.inserted
          total.alreadyPresent += result.alreadyPresent
        },
      )
      for (const table of tables) await tx.unsafe(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)
      return total
    })
  } finally {
    await client.close()
  }
}
