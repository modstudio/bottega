// concern: record-reviews
/** Owns tenant-bound hosted review reads. */
import { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import type { RecordCursor } from './record-runs.ts'

const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
const presentation = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      camel(key),
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'bigint'
          ? Number(value)
          : value,
    ]),
  )

async function tenant<T>(input: { url: string } & TenantPrincipal, read: (tx: SQL) => Promise<T>) {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      return read(tx)
    })
  } finally {
    await client.close()
  }
}

export async function listRecordReviews(input: {
  url: string
  userId: string
  spaceId: string
  spaceIds?: string[]
  limit: number
  before: RecordCursor | null
}) {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT rv.*, sp.name AS space_name, p.name AS project_name,
        count(DISTINCT l.id)::int AS lens_count,
        count(DISTINCT f.id)::int AS finding_count
      FROM review rv JOIN space sp ON sp.id=rv.space_id LEFT JOIN project p ON p.id=rv.project_id
      LEFT JOIN review_lens l ON l.review_id=rv.id LEFT JOIN review_finding f ON f.review_id=rv.id
      WHERE (${input.before?.at ?? null}::timestamptz IS NULL OR (rv.recorded_at, rv.id) < (${input.before?.at ?? null}::timestamptz, ${input.before?.id ?? null}::uuid))
      GROUP BY rv.id, sp.name, p.name ORDER BY rv.recorded_at DESC, rv.id DESC LIMIT ${input.limit + 1}
    `
    return rows.map((row: Record<string, unknown>) => {
      const result = presentation(row)
      return result
    })
  })
}

export async function getRecordReview(input: {
  url: string
  userId: string
  spaceId: string
  spaceIds?: string[]
  id: string
}) {
  return tenant(input, async (tx) => {
    const reviews =
      await tx`SELECT rv.*, sp.name AS space_name, p.name AS project_name FROM review rv
      JOIN space sp ON sp.id=rv.space_id LEFT JOIN project p ON p.id=rv.project_id
      WHERE rv.id=${input.id}::uuid`
    if (!reviews[0]) return null
    const lenses = await tx`
      SELECT l.*, COALESCE(json_agg(f ORDER BY f.ordinal) FILTER (WHERE f.id IS NOT NULL), '[]') AS findings
      FROM review_lens l LEFT JOIN review_finding f ON f.review_lens_id=l.id
      WHERE l.review_id=${input.id}::uuid GROUP BY l.id ORDER BY l.id
    `
    const result = presentation(reviews[0])
    return {
      ...result,
      lenses: lenses.map((row: Record<string, unknown>) => {
        const lens = presentation(row)
        delete lens.spaceId
        return lens
      }),
    }
  })
}
