import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { recordSpaceAccessDecision } from '../../shared/record-space-request.ts'
import {
  listHostedChanges,
  MAX_HUB_CHANGE_PAGE_SIZE,
  READABLE_HUB_CHANGES,
  type ReadableHubChangeTable,
} from './hosted-changes.ts'
import { listHostedIdentitySet } from './hosted-identity-set.ts'
import { applyHostedPushChanges } from './hosted-push-changes.ts'
import { taskSpaceIdentity } from './hosted-route-identity.ts'
import { parseIdentitySetRequest } from './identity-set-contract.ts'
import {
  type HostedPushChange,
  type HostedPushOutcome,
  parseHostedPushItem,
} from './push-contract.ts'

const TEST_REFUSAL =
  'hub change API refuses real identity and database clients unless stubs are injected in tests'

type Config = { recordApiUrl: string; recordDatabaseUrl: SQL | string }
type Dependencies = {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  list?: typeof listHostedChanges
  ids?: typeof listHostedIdentitySet
  push?: typeof applyHostedPushChanges
}
type ChangeIdentity = Exclude<
  Awaited<ReturnType<typeof taskSpaceIdentity>>,
  null | { refusedSpace: string }
>
const database = (config: Config) => config.recordDatabaseUrl as SQL

const allowed = Object.keys(READABLE_HUB_CHANGES) as ReadableHubChangeTable[]
const allowedMessage = allowed.join(', ')
const json = (value: unknown, status = 200) => Response.json(value, { status })

function requestInput(url: URL) {
  const afterValue = url.searchParams.get('after')
  if (afterValue === null || !/^(0|[1-9]\d*)$/.test(afterValue))
    throw new Error('after must be a non-negative safe integer')
  const after = Number(afterValue)
  if (!Number.isSafeInteger(after)) throw new Error('after must be a non-negative safe integer')

  const limitValue = url.searchParams.get('limit')
  const limit = limitValue === null ? MAX_HUB_CHANGE_PAGE_SIZE : Number(limitValue)
  if (
    (limitValue !== null && !/^[1-9]\d*$/.test(limitValue)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_HUB_CHANGE_PAGE_SIZE
  )
    throw new Error(`limit must be an integer from 1 through ${MAX_HUB_CHANGE_PAGE_SIZE}`)

  const tableValues = url.searchParams.getAll('tables')
  if (tableValues.length !== 1 || !tableValues[0])
    throw new Error(`tables must name one or more of: ${allowedMessage}`)
  const tables = tableValues[0].split(',')
  const invalid = tables.filter(
    (table): table is string => !allowed.includes(table as ReadableHubChangeTable),
  )
  if (invalid.length) throw new Error(`tables must name only: ${allowedMessage}`)
  return { after, limit, tables: [...new Set(tables)] as ReadableHubChangeTable[] }
}

function hasTestDependencies(
  pathname: string,
  method: string,
  dependencies: Dependencies,
): boolean {
  if (!dependencies.fetch) return false
  if (pathname === '/v1/changes/ids') return Boolean(dependencies.ids)
  return method === 'GET' ? Boolean(dependencies.list) : Boolean(dependencies.push)
}

function pushInput(
  value: unknown,
): { inputs: HostedPushChange[]; rejected: Map<number, HostedPushOutcome> } | { error: string } {
  if (!Array.isArray(value)) return { error: 'body must be a list of pushed changes' }
  const inputs: HostedPushChange[] = []
  const rejected = new Map<number, HostedPushOutcome>()
  for (const [index, item] of value.entries()) {
    const parsed = parseHostedPushItem(item)
    if ('input' in parsed) inputs.push(parsed.input)
    else rejected.set(index, parsed.outcome)
  }
  return { inputs, rejected }
}

async function pushResponse(
  request: Request,
  config: Config,
  dependencies: Dependencies,
  who: ChangeIdentity,
): Promise<Response> {
  const access = recordSpaceAccessDecision('write', who.spaceId, who.memberships)
  if (!access.allowed) return json({ error: access.error, remedy: access.remedy }, 403)
  const decision = pushInput(await request.json().catch(() => null))
  if ('error' in decision) return json({ error: decision.error }, 400)
  try {
    const applied = await (dependencies.push ?? applyHostedPushChanges)(
      database(config),
      who,
      decision.inputs,
    )
    const outcomes: HostedPushOutcome[] = []
    let appliedIndex = 0
    for (let index = 0; index < decision.inputs.length + decision.rejected.size; index++)
      outcomes.push(decision.rejected.get(index) ?? applied[appliedIndex++]!)
    return json(outcomes)
  } catch (error) {
    return json({ error: (error as Error).message }, 409)
  }
}

async function identityWho(request: Request, config: Config, dependencies: Dependencies) {
  return taskSpaceIdentity(
    request,
    config.recordApiUrl,
    (dependencies.fetch ?? fetch) as typeof fetch,
    true,
  )
}

function refusedSpace(
  who: Awaited<ReturnType<typeof taskSpaceIdentity>>,
): who is { refusedSpace: string } {
  return Boolean(who && 'refusedSpace' in who && who.refusedSpace)
}

function refusedSpaceResponse(space: string) {
  return json(
    {
      error: `record space '${space}' is not among the caller's memberships`,
      remedy: `Run \`${PLATFORM_SLUG} record space list\` and choose a space where the caller is a member.`,
    },
    403,
  )
}

async function identitySetResponse(
  request: Request,
  url: URL,
  config: Config,
  dependencies: Dependencies,
): Promise<Response> {
  if (request.method !== 'GET') return new Response('not found', { status: 404 })
  const who = await identityWho(request, config, dependencies)
  if (!who) return json({ error: 'authorization and an active space are required' }, 401)
  if (refusedSpace(who)) return refusedSpaceResponse(who.refusedSpace)
  let input: ReturnType<typeof parseIdentitySetRequest>
  try {
    input = parseIdentitySetRequest(url)
  } catch (error) {
    return json({ error: (error as Error).message }, 400)
  }
  try {
    return json(
      await (dependencies.ids ?? listHostedIdentitySet)(database(config), who, input),
    )
  } catch (error) {
    return json({ error: (error as Error).message }, 409)
  }
}

async function changeLogResponse(
  request: Request,
  url: URL,
  config: Config,
  dependencies: Dependencies,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST')
    return new Response('not found', { status: 404 })
  const who = await identityWho(request, config, dependencies)
  if (!who) return json({ error: 'authorization and an active space are required' }, 401)
  if (refusedSpace(who)) return refusedSpaceResponse(who.refusedSpace)
  if (request.method === 'POST') return pushResponse(request, config, dependencies, who)
  let input: ReturnType<typeof requestInput>
  try {
    input = requestInput(url)
  } catch (error) {
    return json({ error: (error as Error).message }, 400)
  }
  try {
    return json(
      await (dependencies.list ?? listHostedChanges)(database(config), who, input),
    )
  } catch (error) {
    return json({ error: (error as Error).message }, 409)
  }
}

export async function changeApi(
  request: Request,
  config: Config,
  dependencies: Dependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/v1/changes' && url.pathname !== '/v1/changes/ids') return null
  if (
    process.env.NODE_ENV === 'test' &&
    !hasTestDependencies(url.pathname, request.method, dependencies)
  )
    throw new Error(TEST_REFUSAL)
  if (url.pathname === '/v1/changes/ids')
    return identitySetResponse(request, url, config, dependencies)
  return changeLogResponse(request, url, config, dependencies)
}
