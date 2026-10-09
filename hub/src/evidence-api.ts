import {
  parseRecordSpaceMemberships,
  type RecordSpaceMembership,
} from '../../shared/record-space-membership.ts'
import {
  recordRequestNature,
  recordSpaceAccessDecision,
  recordSpaceRequestDecision,
} from '../../shared/record-space-request.ts'
import type { DayEvidence, IntervalEvidence } from './hosted-evidence.ts'
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
type Tenant = {
  userId: string
  spaceId: string
  spaceIds: string[]
  memberships: RecordSpaceMembership[]
}

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
  const memberships = parseRecordSpaceMemberships(body?.memberships)
  return typeof user?.id === 'string' && typeof body?.activeSpaceId === 'string'
    ? {
        userId: user.id,
        spaceId: body.activeSpaceId,
        spaceIds: memberships.map((membership) => membership.spaceId),
        memberships,
      }
    : null
}

function batch(body: unknown, field: 'rows' | 'ids'): unknown[] | null {
  if (!body || typeof body !== 'object') return null
  const value = (body as Record<string, unknown>)[field]
  return Array.isArray(value) && value.length <= 500 ? value : null
}

function missingRecordId(rows: unknown[]): boolean {
  return rows.some(
    (row) =>
      !row ||
      typeof row !== 'object' ||
      typeof (row as Record<string, unknown>).id !== 'string' ||
      (row as Record<string, unknown>).id === '',
  )
}

async function putIntervalBatch(
  body: unknown,
  config: Config,
  who: Tenant,
  dependencies: Dependencies,
) {
  const rows = batch(body, 'rows')
  if (!rows) return Response.json({ error: 'rows must contain at most 500 items' }, { status: 400 })
  if (missingRecordId(rows))
    return Response.json(
      {
        error:
          'every interval row requires id; upgrade the client to one with intervalRecordId support',
      },
      { status: 400 },
    )
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
  if (missingRecordId(rows))
    return Response.json(
      { error: 'every day row requires id; upgrade the client to one with dayRecordId support' },
      { status: 400 },
    )
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
  const ids = batch(body, 'ids')
  if (ids) {
    if (process.env.NODE_ENV === 'test' && !dependencies.removeIntervals)
      throw new Error(TEST_REFUSAL)
    return Response.json(
      await (dependencies.removeIntervals ?? deleteIntervals)(
        config.recordDatabaseUrl,
        who,
        ids as string[],
      ),
    )
  }
  return Response.json({ error: 'ids must contain at most 500 items' }, { status: 400 })
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
  const intervalRoute =
    url.pathname === '/v1/evidence/intervals' &&
    (request.method === 'PUT' || request.method === 'DELETE')
  const decision = recordSpaceRequestDecision(
    intervalRoute ? request.headers.get('x-record-space') : null,
    who.spaceId,
    who.memberships,
  )
  if (!decision.allowed)
    return Response.json(
      {
        error: `record space '${decision.requestedSpace}' is not among the caller's memberships`,
        remedy: 'Run `orch record space list` and choose a space where the caller is a member.',
      },
      { status: 403 },
    )
  const access = recordSpaceAccessDecision(
    recordRequestNature(request.method),
    decision.spaceId!,
    who.memberships,
  )
  if (!access.allowed)
    return Response.json({ error: access.error, remedy: access.remedy }, { status: 403 })
  const tenant = { ...who, spaceId: decision.spaceId! }
  const body = await request.json().catch(() => null)
  try {
    if (request.method === 'PUT' && url.pathname === '/v1/evidence/intervals')
      return await putIntervalBatch(body, config, tenant, dependencies)
    if (request.method === 'PUT' && url.pathname === '/v1/evidence/days')
      return await putDayBatch(body, config, tenant, dependencies)
    if (request.method === 'DELETE' && url.pathname === '/v1/evidence/intervals')
      return await deleteIntervalBatch(body, config, tenant, dependencies)
    return new Response('not found', { status: 404 })
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 409 })
  }
}
