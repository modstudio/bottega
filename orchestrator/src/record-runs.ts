// concern: record-runs
/** Owns tenant-bound record run reads. Must not know local run phases or CLI presentation. */
import { SQL } from 'bun'

export type RecordRun = {
  id: string
  startedAt: Date
  agent: string
  job: string
  status: string
  latencyMs: number | null
  promptHead: string
}

export async function listRecordRuns(input: {
  url: string
  userId: string
  spaceId: string
  limit: number
}): Promise<RecordRun[]> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${input.userId}, true)`
      await tx`SELECT set_config('app.space_id', ${input.spaceId}, true)`
      const rows = await tx`
        SELECT id, started_at, agent, job, status, latency_ms, prompt_head
        FROM run
        ORDER BY started_at DESC, id DESC
        LIMIT ${input.limit}
      `
      return rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        startedAt: new Date(String(row.started_at)),
        agent: String(row.agent),
        job: String(row.job),
        status: String(row.status),
        latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
        promptHead: String(row.prompt_head),
      }))
    })
  } finally {
    await client.close()
  }
}
