import type { DayEvidence, IntervalEvidence, IntervalKey } from './hosted-evidence.ts'
import { deleteIntervals, upsertDays, upsertIntervals } from './hosted-evidence.ts'

const TEST_REFUSAL =
  'hub evidence API refuses real identity and database clients unless stubs are injected in tests'

type Dependencies = {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  putIntervals?: typeof upsertIntervals
  putDays?: typeof upsertDays
  removeIntervals?: typeof deleteIntervals
}
type Config = { recordApiUrl: string; recordDatabaseUrl: string }
type Tenant = { userId: string; spaceId: string }

async function identity(
  request: Request,
  recordApiUrl: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
) {
  const authorization = request.headers.get('authorization')
  if (!authorization) return null
  const response = await fetchImpl(`${recordApiUrl.replace(/\/$/, '')}/v1/whoami`, {
    headers: { authorization },
  })
  if (!response.ok) return null
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  const user = body?.user as Record<string, unknown> | undefined
  return typeof user?.id === 'string' && typeof body?.activeSpaceId === 'string'
    ? { userId: user.id, spaceId: body.activeSpaceId }
    : null
}

function batch(body: unknown, field: 'rows' | 'keys'): unknown[] | null {
  if (!body || typeof body !== 'object') return null
  const value = (body as Record<string, unknown>)[field]
  return Array.isArray(value) && value.length <= 500 ? value : null
}

async function putIntervalBatch(
  body: unknown,
  config: Config,
  who: Tenant,
  dependencies: Dependencies,
) {
  const rows = batch(body, 'rows')
  if (!rows) return Response.json({ error: 'rows must contain at most 500 items' }, { status: 400 })
  if (process.env.NODE_ENV === 'test' && !dependencies.putIntervals) throw new Error(TEST_REFUSAL)
  return Response.json(
    await (dependencies.putIntervals ?? upsertIntervals)(
      config.recordDatabaseUrl,
      who,
      rows as IntervalEvidence[],
    ),
  )
}

async function putDayBatch(body: unknown, config: Config, who: Tenant, dependencies: Dependencies) {
  const rows = batch(body, 'rows')
  if (!rows) return Response.json({ error: 'rows must contain at most 500 items' }, { status: 400 })
  if (process.env.NODE_ENV === 'test' && !dependencies.putDays) throw new Error(TEST_REFUSAL)
  return Response.json(
    await (dependencies.putDays ?? upsertDays)(
      config.recordDatabaseUrl,
      who,
      rows as DayEvidence[],
    ),
  )
}

async function deleteIntervalBatch(
  body: unknown,
  config: Config,
  who: Tenant,
  dependencies: Dependencies,
) {
  const keys = batch(body, 'keys')
  if (!keys) return Response.json({ error: 'keys must contain at most 500 items' }, { status: 400 })
  if (process.env.NODE_ENV === 'test' && !dependencies.removeIntervals)
    throw new Error(TEST_REFUSAL)
  return Response.json(
    await (dependencies.removeIntervals ?? deleteIntervals)(
      config.recordDatabaseUrl,
      who,
      keys as IntervalKey[],
    ),
  )
}

export async function evidenceApi(
  request: Request,
  config: Config,
  dependencies: Dependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/v1/evidence/')) return null
  if (!request.headers.has('authorization'))
    return Response.json(
      { error: 'authorization and an active space are required' },
      { status: 401 },
    )
  if (process.env.NODE_ENV === 'test' && !dependencies.fetch) throw new Error(TEST_REFUSAL)
  const who = await identity(request, config.recordApiUrl, dependencies.fetch ?? fetch)
  if (!who)
    return Response.json(
      { error: 'authorization and an active space are required' },
      { status: 401 },
    )
  const body = await request.json().catch(() => null)
  if (request.method === 'PUT' && url.pathname === '/v1/evidence/intervals')
    return putIntervalBatch(body, config, who, dependencies)
  if (request.method === 'PUT' && url.pathname === '/v1/evidence/days')
    return putDayBatch(body, config, who, dependencies)
  if (request.method === 'DELETE' && url.pathname === '/v1/evidence/intervals')
    return deleteIntervalBatch(body, config, who, dependencies)
  return new Response('not found', { status: 404 })
}
