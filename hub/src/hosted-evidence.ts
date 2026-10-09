import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'

export type EvidenceIdentity = { userId: string; spaceId: string }
export type IntervalEvidence = {
  id?: string
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
export type IntervalKey = { source: string; ref: string; start_at: string }

export type HostedIntervalPut =
  | { kind: 'update'; id: string }
  | { kind: 'rekey'; fromId: string; toId: string }
  | { kind: 'insert'; id: string }
  | { kind: 'insert-legacy' }

/** Choose insert, update, or re-key from the incoming id and hosted rows in this space. */
export function decideHostedIntervalPut(
  incomingId: string | undefined,
  existingId: string | null,
  existingTupleId: string | null,
): HostedIntervalPut {
  if (!incomingId) return { kind: 'insert-legacy' }
  if (existingId) return { kind: 'update', id: incomingId }
  if (existingTupleId) return { kind: 'rekey', fromId: existingTupleId, toId: incomingId }
  return { kind: 'insert', id: incomingId }
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
  currentId: string,
  nextId: string,
  row: IntervalEvidence,
) {
  const value = intervalValues(row)
  await tx`
    UPDATE hub_interval SET
      id=${nextId}::uuid, task_key=${value.task_key}, project_name=${value.project_name},
      source=${value.source}, agent=${value.agent}, job=${value.job},
      start_at=${value.start_at}::timestamptz, end_at=${value.end_at}::timestamptz,
      claude_tokens=${value.claude_tokens}, vendor_tokens=${value.vendor_tokens},
      vendor_cost_usd=${value.vendor_cost_usd}, ref=${value.ref}, via=${value.via},
      open=${value.open}, session_id=${value.session_id}, user_id=${value.user_id}::uuid,
      updated_at=now()
    WHERE id=${currentId}::uuid AND space_id=${identity.spaceId}::uuid
  `
}

async function writeLegacyInterval(tx: SQL, identity: EvidenceIdentity, row: IntervalEvidence) {
  const value = intervalValues(row)
  await tx`
    INSERT INTO hub_interval
      (id, space_id, task_key, project_name, source, agent, job, start_at, end_at,
       claude_tokens, vendor_tokens, vendor_cost_usd, ref, via, open, session_id, user_id, updated_at)
    VALUES
      (${newRecordId()}::uuid, ${identity.spaceId}::uuid, ${value.task_key}, ${value.project_name},
       ${value.source}, ${value.agent}, ${value.job}, ${value.start_at}::timestamptz,
       ${value.end_at}::timestamptz, ${value.claude_tokens}, ${value.vendor_tokens},
       ${value.vendor_cost_usd}, ${value.ref}, ${value.via}, ${value.open}, ${value.session_id},
       ${value.user_id}::uuid, now())
    ON CONFLICT (space_id, source, ref, start_at) DO UPDATE SET
      task_key=excluded.task_key, project_name=excluded.project_name, agent=excluded.agent,
      job=excluded.job, end_at=excluded.end_at, claude_tokens=excluded.claude_tokens,
      vendor_tokens=excluded.vendor_tokens, vendor_cost_usd=excluded.vendor_cost_usd,
      via=excluded.via, open=excluded.open, session_id=excluded.session_id,
      user_id=excluded.user_id, updated_at=now()
  `
}

async function upsertOneInterval(
  tx: SQL,
  identity: EvidenceIdentity,
  row: IntervalEvidence,
): Promise<number> {
  const byId = row.id
    ? await tx<{ id: string }[]>`
        SELECT id::text AS id FROM hub_interval
        WHERE space_id=${identity.spaceId}::uuid AND id=${row.id}::uuid`
    : []
  const byTuple = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM hub_interval
    WHERE space_id=${identity.spaceId}::uuid AND source=${row.source} AND ref=${row.ref}
      AND start_at=${row.start_at}::timestamptz`
  const decision = decideHostedIntervalPut(row.id, byId[0]?.id ?? null, byTuple[0]?.id ?? null)
  if (decision.kind === 'insert-legacy') {
    await writeLegacyInterval(tx, identity, row)
    return 0
  }
  if (decision.kind === 'rekey') {
    // Re-keys a hosted interval to the client's record_id.
    await updateHostedInterval(tx, identity, decision.fromId, decision.toId, row)
    return 1
  }
  if (decision.kind === 'update')
    await updateHostedInterval(tx, identity, decision.id, decision.id, row)
  else await insertHostedInterval(tx, identity, decision.id, row)
  return 0
}

export async function upsertIntervals(
  url: string,
  identity: EvidenceIdentity,
  rows: IntervalEvidence[],
) {
  return tenant(url, identity, async (tx) => {
    let rekeyed = 0
    for (const row of rows) rekeyed += await upsertOneInterval(tx, identity, row)
    return { upserted: rows.length, rekeyed }
  })
}

export async function upsertDays(url: string, identity: EvidenceIdentity, rows: DayEvidence[]) {
  return tenant(url, identity, async (tx) => {
    for (const row of rows) {
      await tx`
        INSERT INTO hub_day
          (id, space_id, day, claude_tokens, cache_read, messages, tasks, canon_tokens,
           other_tokens, commits, files, lines_product, lines_test, lines_docs, lines_config,
           lines_generated, collected_at, updated_at)
        VALUES
          (${newRecordId()}::uuid, ${identity.spaceId}::uuid, ${row.day}, ${row.claude_tokens},
           ${row.cache_read}, ${row.messages}, ${row.tasks}, ${row.canon_tokens},
           ${row.other_tokens}, ${row.commits}, ${row.files}, ${row.lines_product},
           ${row.lines_test}, ${row.lines_docs}, ${row.lines_config}, ${row.lines_generated},
           ${row.collected_at}::timestamptz, now())
        ON CONFLICT (space_id, day) DO UPDATE SET
          claude_tokens=excluded.claude_tokens, cache_read=excluded.cache_read,
          messages=excluded.messages, tasks=excluded.tasks, canon_tokens=excluded.canon_tokens,
          other_tokens=excluded.other_tokens, commits=excluded.commits, files=excluded.files,
          lines_product=excluded.lines_product, lines_test=excluded.lines_test,
          lines_docs=excluded.lines_docs, lines_config=excluded.lines_config,
          lines_generated=excluded.lines_generated, collected_at=excluded.collected_at,
          updated_at=now()
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

export async function deleteIntervalKeys(
  url: string,
  identity: EvidenceIdentity,
  keys: IntervalKey[],
) {
  return tenant(url, identity, async (tx) => {
    let deleted = 0
    for (const key of keys) {
      const rows = await tx`
        DELETE FROM hub_interval
        WHERE space_id=${identity.spaceId}::uuid AND source=${key.source} AND ref=${key.ref}
          AND start_at=${key.start_at}::timestamptz
        RETURNING id
      `
      deleted += rows.length
    }
    return { deleted }
  })
}
