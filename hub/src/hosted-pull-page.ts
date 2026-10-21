import type { SQL } from 'bun'

const HOSTED_PULL_PAGE_SIZE = 500
export const HOSTED_PULL_BODY_BYTE_BUDGET = 4 * 1024 * 1024

const FIRST_ID = '00000000-0000-0000-0000-000000000000'
const FIRST_AT = '1970-01-01T00:00:00.000000Z'

export type HostedPullCursor<Stream extends string> = {
  stream: Stream
  at: string
  id: string
  since: string
}

export type HostedPullMeasuredRow<Row> = Row & {
  cursor_at: string
  pull_body_bytes?: string
  pull_more?: boolean
  pull_row_number?: string
}

type SqlFragment = ReturnType<SQL['unsafe']>

export function hostedPullBodyCandidates<Row>(tx: SQL, bodyExpression: SqlFragment, limit: number) {
  return async (pending: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> => {
    const strings = [
      `WITH pending AS MATERIALIZED (${pending[0]!}`,
      ...pending.slice(1, -1),
      `${pending.at(-1)!} ORDER BY updated_at,id LIMIT `,
      `), measured AS (
        SELECT pending.*,
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at,
          SUM(octet_length(`,
      `)) OVER (ORDER BY updated_at,id) pull_body_bytes,
          ROW_NUMBER() OVER (ORDER BY updated_at,id) pull_row_number
        FROM pending
      )
      SELECT measured.*,EXISTS(
        SELECT 1 FROM measured omitted
        WHERE omitted.pull_row_number > 1
          AND omitted.pull_body_bytes > `,
      `
      ) pull_more
      FROM measured
      WHERE pull_row_number=1 OR pull_body_bytes <= `,
      `
      ORDER BY updated_at,id`,
    ] as unknown as TemplateStringsArray
    Object.defineProperty(strings, 'raw', { value: strings })
    const rows = await tx(
      strings,
      ...values,
      limit + 1,
      bodyExpression,
      HOSTED_PULL_BODY_BYTE_BUDGET,
      HOSTED_PULL_BODY_BYTE_BUDGET,
    )
    return rows as Row[]
  }
}

export function hostedPullRowValue<Row>(row: HostedPullMeasuredRow<Row>): Row {
  const {
    cursor_at: _,
    pull_body_bytes: _pullBodyBytes,
    pull_more: _pullMore,
    pull_row_number: _pullRowNumber,
    ...value
  } = row
  return value as Row
}

const validTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

export function hostedPullLimit(value: number | undefined) {
  const limit = value ?? HOSTED_PULL_PAGE_SIZE
  if (!Number.isInteger(limit) || limit < 1 || limit > HOSTED_PULL_PAGE_SIZE)
    throw new Error(`limit must be an integer from 1 through ${HOSTED_PULL_PAGE_SIZE}`)
  return limit
}

export function encodeHostedPullCursor<Stream extends string>(cursor: HostedPullCursor<Stream>) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

export function decodeHostedPullCursor<Stream extends string>(
  value: string | undefined,
  streams: readonly Stream[],
  updatedSince?: string,
): HostedPullCursor<Stream> {
  const since = updatedSince ?? FIRST_AT
  if (!value) return { stream: streams[0]!, at: since, id: FIRST_ID, since }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as Record<string, unknown>
    if (
      streams.includes(parsed.stream as Stream) &&
      validTimestamp(parsed.at) &&
      validId(parsed.id) &&
      validTimestamp(parsed.since)
    )
      return parsed as HostedPullCursor<Stream>
  } catch {
    // The timestamp-only cursor was the previous wire format.
  }
  if (validTimestamp(value)) return { stream: streams[0]!, at: value, id: FIRST_ID, since: value }
  throw new Error('hosted pull cursor is malformed')
}

const hostedPullCursorAt = (value: unknown) => String(value)

export function hostedPullPage<
  Stream extends string,
  Row extends { id: string; cursor_at: string; pull_more?: boolean },
>(
  streams: readonly Stream[],
  cursor: HostedPullCursor<Stream>,
  candidates: readonly Row[],
  limit: number,
) {
  const position = streams.indexOf(cursor.stream)
  if (!candidates.length && position < streams.length - 1)
    return {
      kind: 'advance' as const,
      cursor: {
        ...cursor,
        stream: streams[position + 1]!,
        at: cursor.since,
        id: FIRST_ID,
      },
    }

  const rows = candidates.slice(0, limit)
  const last = rows.at(-1)
  return {
    kind: 'page' as const,
    rows,
    cursor: last ? { ...cursor, at: hostedPullCursorAt(last.cursor_at), id: last.id } : cursor,
    more:
      candidates.length > limit ||
      candidates.some((candidate) => candidate.pull_more === true) ||
      position < streams.length - 1,
  }
}
