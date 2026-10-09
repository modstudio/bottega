import { SQL } from 'bun'

export type EvidenceIdentity = { userId: string; spaceId: string }
export type IntervalEvidence = {
  id: string
  task_key: string | null
  project_name: string | null
  source: string
  agent: string | null
  job: string | null
  start_at: string
  end_at: string
  claude_tokens: number
  vendor_tokens: number
  vendor_cost_usd: number | null
  ref: string
  via: string | null
  open: number
  session_id: string | null
  user_id: string | null
}
export type DayEvidence = {
  id: string
  day: string
  claude_tokens: number
  cache_read: number
  messages: number
  tasks: number
  canon_tokens: number
  other_tokens: number
  commits: number
  files: number
  lines_product: number
  lines_test: number
  lines_docs: number
  lines_config: number
  lines_generated: number
  collected_at: string
}
function intervalIdentityConflict(row: IntervalEvidence, existingId: string): Error {
  return new Error(
    `interval identity conflict: tuple (${row.source}, ${row.ref}, ${row.start_at}) belongs to UUID ${existingId}, not incoming UUID ${row.id}`,
  )
}

function dayIdentityConflict(row: DayEvidence, existingId: string): Error {
  return new Error(
    `day identity conflict: date ${row.day} belongs to UUID ${existingId}, not incoming UUID ${row.id}`,
  )
}

export function hostedIntervalWrite(
  row: IntervalEvidence,
  existingId: string | null,
  existingTupleId: string | null,
): 'update' | 'insert' {
  if (existingId) return 'update'
  if (existingTupleId) throw intervalIdentityConflict(row, existingTupleId)
  return 'insert'
}

export function hostedDayWrite(
  row: DayEvidence,
  existingId: string | null,
  existingDayId: string | null,
): 'update' | 'insert' {
  if (existingId) return 'update'
  if (existingDayId) throw dayIdentityConflict(row, existingDayId)
  return 'insert'
}

async function tenant<T>(url: string, identity: EvidenceIdentity, work: (tx: SQL) => Promise<T>) {
  const client = new SQL(url)
  try {
    return await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${identity.userId}, true)`
      await tx`SELECT set_config('app.space_id', ${identity.spaceId}, true)`
      return work(tx)
    })
  } finally {
    await client.close()
  }
}

function intervalValues(row: IntervalEvidence) {
  return {
    task_key: row.task_key,
    project_name: row.project_name,
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
) {
  const value = intervalValues(row)
  await tx`
    INSERT INTO hub_interval
      (id, space_id, task_key, project_name, source, agent, job, start_at, end_at,
       claude_tokens, vendor_tokens, vendor_cost_usd, ref, via, open, session_id, user_id, updated_at)
    VALUES
      (${id}::uuid, ${identity.spaceId}::uuid, ${value.task_key}, ${value.project_name},
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
) {
  const value = intervalValues(row)
  await tx`
    UPDATE hub_interval SET
      task_key=${value.task_key}, project_name=${value.project_name}, source=${value.source},
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
): Promise<void> {
  const byId = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM hub_interval
    WHERE space_id=${identity.spaceId}::uuid AND id=${row.id}::uuid`
  const byTuple = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM hub_interval
    WHERE space_id=${identity.spaceId}::uuid AND source=${row.source} AND ref=${row.ref}
      AND start_at=${row.start_at}::timestamptz`
  const write = hostedIntervalWrite(row, byId[0]?.id ?? null, byTuple[0]?.id ?? null)
  if (write === 'update') {
    await updateHostedInterval(tx, identity, row.id, row)
    return
  }
  await insertHostedInterval(tx, identity, row.id, row)
}

export async function upsertIntervals(
  url: string,
  identity: EvidenceIdentity,
  rows: IntervalEvidence[],
) {
  return tenant(url, identity, async (tx) => {
    for (const row of rows) await upsertOneInterval(tx, identity, row)
    return { upserted: rows.length }
  })
}

export async function upsertDays(url: string, identity: EvidenceIdentity, rows: DayEvidence[]) {
  return tenant(url, identity, async (tx) => {
    for (const row of rows) {
      const byId = await tx<{ id: string }[]>`
        SELECT id::text AS id FROM hub_day
        WHERE space_id=${identity.spaceId}::uuid AND id=${row.id}::uuid`
      const byDay = await tx<{ id: string }[]>`
        SELECT id::text AS id FROM hub_day
        WHERE space_id=${identity.spaceId}::uuid AND day=${row.day}`
      const write = hostedDayWrite(row, byId[0]?.id ?? null, byDay[0]?.id ?? null)
      if (write === 'update') {
        await tx`
          UPDATE hub_day SET
            day=${row.day}, claude_tokens=${row.claude_tokens}, cache_read=${row.cache_read},
            messages=${row.messages}, tasks=${row.tasks}, canon_tokens=${row.canon_tokens},
            other_tokens=${row.other_tokens}, commits=${row.commits}, files=${row.files},
            lines_product=${row.lines_product}, lines_test=${row.lines_test},
            lines_docs=${row.lines_docs}, lines_config=${row.lines_config},
            lines_generated=${row.lines_generated}, collected_at=${row.collected_at}::timestamptz,
            updated_at=now()
          WHERE id=${row.id}::uuid AND space_id=${identity.spaceId}::uuid
        `
        continue
      }
      await tx`
        INSERT INTO hub_day
          (id, space_id, day, claude_tokens, cache_read, messages, tasks, canon_tokens,
           other_tokens, commits, files, lines_product, lines_test, lines_docs, lines_config,
           lines_generated, collected_at, updated_at)
        VALUES
          (${row.id}::uuid, ${identity.spaceId}::uuid, ${row.day}, ${row.claude_tokens},
           ${row.cache_read}, ${row.messages}, ${row.tasks}, ${row.canon_tokens},
           ${row.other_tokens}, ${row.commits}, ${row.files}, ${row.lines_product},
           ${row.lines_test}, ${row.lines_docs}, ${row.lines_config}, ${row.lines_generated},
           ${row.collected_at}::timestamptz, now())
      `
    }
    return { upserted: rows.length }
  })
}

export async function deleteIntervals(url: string, identity: EvidenceIdentity, ids: string[]) {
  return tenant(url, identity, async (tx) => {
    let deleted = 0
    for (const id of ids) {
      const rows = await tx`
        DELETE FROM hub_interval
        WHERE space_id=${identity.spaceId}::uuid AND id=${id}::uuid
        RETURNING id
      `
      deleted += rows.length
    }
    return { deleted }
  })
}
