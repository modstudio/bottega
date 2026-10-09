import type { IntervalEvidence } from '../src/hosted-evidence.ts'

export type HostedIntervalCopy = {
  spaceId: string
  id: string
  source: string
  ref: string
  start_at: string
}

export function applyHostedIntervalWrite(
  hosted: HostedIntervalCopy[],
  method: string,
  spaceId: string,
  body: Record<string, unknown>,
): Response {
  if (method === 'DELETE') {
    if (!Array.isArray(body.ids))
      return Response.json({ error: 'ids must contain at most 500 items' }, { status: 400 })
    const ids = body.ids as string[]
    hosted.splice(
      0,
      hosted.length,
      ...hosted.filter((row) => row.spaceId !== spaceId || !ids.includes(row.id)),
    )
    return Response.json({ deleted: ids.length })
  }
  if (method !== 'PUT') return Response.json({ error: 'method not allowed' }, { status: 405 })
  const rows = (body.rows as IntervalEvidence[] | undefined) ?? []
  if (rows.some((row) => typeof row.id !== 'string' || row.id === ''))
    return Response.json(
      {
        error:
          'every interval row requires id; upgrade the client to one with intervalRecordId support',
      },
      { status: 400 },
    )
  const next = hosted.map((row) => ({ ...row }))
  for (const row of rows) {
    const existing = next.find((copy) => copy.spaceId === spaceId && copy.id === row.id)
    if (existing) {
      Object.assign(existing, {
        source: row.source,
        ref: row.ref,
        start_at: row.start_at,
      })
      continue
    }
    const collision = next.find(
      (copy) =>
        copy.spaceId === spaceId &&
        copy.source === row.source &&
        copy.ref === row.ref &&
        copy.start_at === row.start_at,
    )
    if (collision)
      return Response.json(
        {
          error: `interval identity conflict: tuple (${row.source}, ${row.ref}, ${row.start_at}) belongs to UUID ${collision.id}, not incoming UUID ${row.id}`,
        },
        { status: 409 },
      )
    next.push({ spaceId, id: row.id, source: row.source, ref: row.ref, start_at: row.start_at })
  }
  hosted.splice(0, hosted.length, ...next)
  return Response.json({ upserted: rows.length })
}
