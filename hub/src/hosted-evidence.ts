import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'

export type EvidenceIdentity = { userId: string; spaceId: string }
export type IntervalEvidence = {
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

export async function upsertIntervals(
  url: string,
  identity: EvidenceIdentity,
  rows: IntervalEvidence[],
) {
  return tenant(url, identity, async (tx) => {
    for (const row of rows) {
      await tx`
        INSERT INTO hub_interval
          (id, space_id, task_key, project_name, source, agent, job, start_at, end_at,
           claude_tokens, vendor_tokens, vendor_cost_usd, ref, via, open, session_id, user_id, updated_at)
        VALUES
          (${newRecordId()}::uuid, ${identity.spaceId}::uuid, ${row.task_key}, ${row.project_name},
           ${row.source}, ${row.agent}, ${row.job}, ${row.start_at}::timestamptz,
           ${row.end_at}::timestamptz, ${row.claude_tokens}, ${row.vendor_tokens},
           ${row.vendor_cost_usd}, ${row.ref}, ${row.via}, ${row.open}, ${row.session_id},
           ${row.user_id}::uuid, now())
        ON CONFLICT (space_id, source, ref, start_at) DO UPDATE SET
          task_key=excluded.task_key, project_name=excluded.project_name, agent=excluded.agent,
          job=excluded.job, end_at=excluded.end_at, claude_tokens=excluded.claude_tokens,
          vendor_tokens=excluded.vendor_tokens, vendor_cost_usd=excluded.vendor_cost_usd,
          via=excluded.via, open=excluded.open, session_id=excluded.session_id,
          user_id=excluded.user_id, updated_at=now()
      `
    }
    return { upserted: rows.length }
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

export async function deleteIntervals(
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
