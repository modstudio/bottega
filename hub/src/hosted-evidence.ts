import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { storedHubProjectId } from './hosted-project-identity.ts'
import type { PushedDay, PushedInterval } from './push-contract.ts'
export type EvidenceIdentity = { userId: string; spaceId: string }
export type IntervalEvidence = PushedInterval
export type DayEvidence = PushedDay
function dayIdentityConflict(row: DayEvidence, existingId: string): Error {
  return new Error(
    `day identity conflict: date ${row.day} belongs to UUID ${existingId}, not incoming UUID ${row.id}`,
  )
}

export function hostedIntervalWrite(
  incomingId: string,
  exists: boolean,
  existingTupleId: string | null,
): 'update' | 'insert' | 'replace' | 'superseded' {
  if (!existingTupleId || existingTupleId === incomingId) return exists ? 'update' : 'insert'
  return incomingId > existingTupleId ? 'replace' : 'superseded'
}

export function hostedDayWrite(
  row: DayEvidence,
  existingId: string | null,
  existingMachineDayId: string | null,
): 'update' | 'insert' {
  if (existingId) return 'update'
  if (existingMachineDayId) throw dayIdentityConflict(row, existingMachineDayId)
  return 'insert'
}

function intervalValues(
  row: IntervalEvidence,
  projectId: string | null,
  taskId: string | null = null,
) {
  return {
    task_key: row.task_key,
    task_id: taskId,
    project_name: row.project_name,
    project_id: projectId,
    source: row.source,
    agent: row.agent,
    job: row.job,
    start_at: row.start_at,
    end_at: row.end_at,
    claude_tokens: row.claude_tokens,
    vendor_tokens: row.vendor_tokens,
    vendor_cost_usd: row.vendor_cost_usd,
    ref: row.ref,
    via: row.via,
    open: row.open,
    session_id: row.session_id,
    user_id: row.user_id,
  }
}

async function insertHostedInterval(
  tx: SQL,
  identity: EvidenceIdentity,
  id: string,
  row: IntervalEvidence,
  projectId: string | null,
  taskId: string | null,
) {
  const value = intervalValues(row, projectId, taskId)
  await tx`
    INSERT INTO hub_interval
      (id, space_id, task_key, task_id, project_name, project_id, source, agent, job, start_at, end_at,
       claude_tokens, vendor_tokens, vendor_cost_usd, ref, via, open, session_id, user_id, updated_at)
    VALUES
      (${id}::uuid, ${identity.spaceId}::uuid, ${value.task_key}, ${value.task_id}::uuid, ${value.project_name}, ${value.project_id}::uuid,
       ${value.source}, ${value.agent}, ${value.job}, ${value.start_at}::timestamptz,
       ${value.end_at}::timestamptz, ${value.claude_tokens}, ${value.vendor_tokens},
       ${value.vendor_cost_usd}, ${value.ref}, ${value.via}, ${value.open}, ${value.session_id},
       ${value.user_id}::uuid, now())
  `
}

async function updateHostedInterval(
  tx: SQL,
  identity: EvidenceIdentity,
  id: string,
  row: IntervalEvidence,
  projectId: string | null,
  taskId: string | null,
) {
  const value = intervalValues(row, projectId, taskId)
  const taskIdAssignment =
    'task_id' in row
      ? tx.unsafe(`task_id=${value.task_id ? `'${value.task_id}'::uuid` : 'NULL'},`)
      : tx.unsafe('')
  await tx`
    UPDATE hub_interval SET
      task_key=${value.task_key}, ${taskIdAssignment}
      project_name=${value.project_name}, project_id=${value.project_id}::uuid, source=${value.source},
      agent=${value.agent}, job=${value.job},
      start_at=${value.start_at}::timestamptz, end_at=${value.end_at}::timestamptz,
      claude_tokens=${value.claude_tokens}, vendor_tokens=${value.vendor_tokens},
      vendor_cost_usd=${value.vendor_cost_usd}, ref=${value.ref}, via=${value.via},
      open=${value.open}, session_id=${value.session_id}, user_id=${value.user_id}::uuid,
      updated_at=now()
    WHERE id=${id}::uuid AND space_id=${identity.spaceId}::uuid
  `
}

async function upsertOneInterval(
  tx: SQL,
  identity: EvidenceIdentity,
  row: IntervalEvidence,
): Promise<{ status: 'applied' | 'duplicate'; replacedId?: string; reason?: string }> {
  const byId = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM hub_interval
    WHERE space_id=${identity.spaceId}::uuid AND id=${row.id}::uuid`
  const byTuple = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM hub_interval
    WHERE space_id=${identity.spaceId}::uuid AND source=${row.source} AND ref=${row.ref}
      AND start_at=${row.start_at}::timestamptz`
  const tupleHolder = byTuple[0]?.id ?? null
  const write = hostedIntervalWrite(row.id, byId.length > 0, tupleHolder)
  if (write === 'superseded')
    return {
      status: 'duplicate',
      reason: `interval superseded by newer UUID ${tupleHolder}`,
    }
  const projectId = await storedHubProjectId(tx, identity.spaceId, {
    projectId: row.projectId,
    projectName: row.project_name,
  })
  const taskId =
    'task_id' in row && row.task_id
      ? ((
          await tx<{ id: string }[]>`SELECT id::text AS id FROM hub_task
            WHERE space_id=${identity.spaceId}::uuid AND id=${row.task_id}::uuid`
        )[0]?.id ?? null)
      : null
  if (write === 'update') {
    const matches = await tx`SELECT 1 FROM hub_interval
      WHERE space_id=${identity.spaceId}::uuid AND id=${row.id}::uuid
        AND task_key IS NOT DISTINCT FROM ${row.task_key}
        AND (${!('task_id' in row)} OR task_id IS NOT DISTINCT FROM ${taskId}::uuid)
        AND project_name IS NOT DISTINCT FROM ${row.project_name}
        AND project_id IS NOT DISTINCT FROM ${projectId}::uuid AND source=${row.source}
        AND agent IS NOT DISTINCT FROM ${row.agent} AND job IS NOT DISTINCT FROM ${row.job}
        AND start_at=${row.start_at}::timestamptz AND end_at=${row.end_at}::timestamptz
        AND claude_tokens=${row.claude_tokens} AND vendor_tokens=${row.vendor_tokens}
        AND vendor_cost_usd IS NOT DISTINCT FROM ${row.vendor_cost_usd} AND ref=${row.ref}
        AND via IS NOT DISTINCT FROM ${row.via} AND open=${row.open}
        AND session_id IS NOT DISTINCT FROM ${row.session_id}
        AND user_id IS NOT DISTINCT FROM ${row.user_id}::uuid`
    if (matches.length) return { status: 'duplicate' }
    await updateHostedInterval(tx, identity, row.id, row, projectId, taskId)
    return { status: 'applied' }
  }
  if (write === 'replace') {
    await tx`DELETE FROM hub_interval
      WHERE space_id=${identity.spaceId}::uuid AND id=${tupleHolder!}::uuid`
    if (byId.length) await updateHostedInterval(tx, identity, row.id, row, projectId, taskId)
    else await insertHostedInterval(tx, identity, row.id, row, projectId, taskId)
  } else await insertHostedInterval(tx, identity, row.id, row, projectId, taskId)
  return {
    status: 'applied',
    ...(write === 'replace' ? { replacedId: tupleHolder! } : {}),
  }
}

export async function applyIntervalChangeInTransaction(
  tx: SQL,
  identity: EvidenceIdentity,
  change: { id: string; op: 'delete' } | { id: string; op: 'upsert'; row: IntervalEvidence },
): Promise<{ status: 'applied' | 'duplicate'; replacedId?: string }> {
  if (change.op === 'upsert') return upsertOneInterval(tx, identity, change.row)
  const deleted = await tx`DELETE FROM hub_interval
    WHERE space_id=${identity.spaceId}::uuid AND id=${change.id}::uuid RETURNING id`
  return { status: deleted.length ? 'applied' : 'duplicate' }
}

export async function applyDayChangeInTransaction(
  tx: SQL,
  identity: EvidenceIdentity,
  row: DayEvidence,
): Promise<'applied' | 'duplicate'> {
  const knownMachine = await tx`SELECT 1 FROM machine
    WHERE id=${row.machine_id}::uuid AND user_id=${identity.userId}::uuid`
  if (!knownMachine.length)
    throw new Error(
      `machine ${row.machine_id} is unknown or belongs to another user; run ${PLATFORM_SLUG} record sync to register the machine`,
    )
  const existing = await tx<{ id: string; by_id: boolean; machine_id: string | null }[]>`
    SELECT id::text AS id,id=${row.id}::uuid AS by_id,machine_id::text FROM hub_day
    WHERE space_id=${identity.spaceId}::uuid
      AND (id=${row.id}::uuid OR (machine_id=${row.machine_id}::uuid AND day=${row.day}))`
  const byId = existing.find((candidate) => candidate.by_id)?.id ?? null
  const idHolder = existing.find((candidate) => candidate.by_id)
  if (idHolder?.machine_id && idHolder.machine_id !== row.machine_id)
    throw dayIdentityConflict(row, idHolder.id)
  const byDay = existing.find((candidate) => !candidate.by_id)?.id ?? byId
  const write = hostedDayWrite(row, byId, byDay)
  if (write === 'insert') {
    await tx`
      INSERT INTO hub_day
        (id, space_id, machine_id, day, claude_tokens, cache_read, messages, tasks, canon_tokens,
         other_tokens, commits, files, lines_product, lines_test, lines_docs, lines_config,
         lines_generated, collected_at, updated_at)
      VALUES
        (${row.id}::uuid, ${identity.spaceId}::uuid, ${row.machine_id}::uuid, ${row.day}, ${row.claude_tokens},
         ${row.cache_read}, ${row.messages}, ${row.tasks}, ${row.canon_tokens},
         ${row.other_tokens}, ${row.commits}, ${row.files}, ${row.lines_product},
         ${row.lines_test}, ${row.lines_docs}, ${row.lines_config}, ${row.lines_generated},
         ${row.collected_at}::timestamptz, now())`
    return 'applied'
  }
  const matches = await tx`SELECT 1 FROM hub_day
    WHERE space_id=${identity.spaceId}::uuid AND id=${row.id}::uuid AND day=${row.day}
      AND machine_id=${row.machine_id}::uuid
      AND claude_tokens=${row.claude_tokens} AND cache_read=${row.cache_read}
      AND messages=${row.messages} AND tasks=${row.tasks} AND canon_tokens=${row.canon_tokens}
      AND other_tokens=${row.other_tokens} AND commits=${row.commits} AND files=${row.files}
      AND lines_product=${row.lines_product} AND lines_test=${row.lines_test}
      AND lines_docs=${row.lines_docs} AND lines_config=${row.lines_config}
      AND lines_generated=${row.lines_generated}
      AND (day < (SELECT max(day) FROM hub_day WHERE space_id=${identity.spaceId}::uuid
          AND machine_id=${row.machine_id}::uuid)
        OR collected_at=${row.collected_at}::timestamptz)`
  if (matches.length) return 'duplicate'
  await tx`
    UPDATE hub_day SET
      machine_id=${row.machine_id}::uuid, day=${row.day}, claude_tokens=${row.claude_tokens}, cache_read=${row.cache_read},
      messages=${row.messages}, tasks=${row.tasks}, canon_tokens=${row.canon_tokens},
      other_tokens=${row.other_tokens}, commits=${row.commits}, files=${row.files},
      lines_product=${row.lines_product}, lines_test=${row.lines_test},
      lines_docs=${row.lines_docs}, lines_config=${row.lines_config},
      lines_generated=${row.lines_generated}, collected_at=${row.collected_at}::timestamptz,
      updated_at=now()
    WHERE id=${row.id}::uuid AND space_id=${identity.spaceId}::uuid`
  return 'applied'
}
