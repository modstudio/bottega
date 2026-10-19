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
