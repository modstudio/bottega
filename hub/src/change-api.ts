import {
  listHostedChanges,
  MAX_HUB_CHANGE_PAGE_SIZE,
  READABLE_HUB_CHANGES,
  type ReadableHubChangeTable,
} from './hosted-changes.ts'
import { taskSpaceIdentity } from './hosted-route-identity.ts'

const TEST_REFUSAL =
  'hub change API refuses real identity and database clients unless stubs are injected in tests'

type Config = { recordApiUrl: string; recordDatabaseUrl: string }
type Dependencies = {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  list?: typeof listHostedChanges
}

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

export async function changeApi(
  request: Request,
  config: Config,
  dependencies: Dependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/v1/changes') return null
  if (request.method !== 'GET') return new Response('not found', { status: 404 })
  if (process.env.NODE_ENV === 'test' && (!dependencies.fetch || !dependencies.list))
    throw new Error(TEST_REFUSAL)
  const who = await taskSpaceIdentity(
    request,
    config.recordApiUrl,
    (dependencies.fetch ?? fetch) as typeof fetch,
    true,
  )
  if (!who) return json({ error: 'authorization and an active space are required' }, 401)
  if ('refusedSpace' in who)
    return json(
      {
        error: `record space '${who.refusedSpace}' is not among the caller's memberships`,
        remedy: 'Run `orch record space list` and choose a space where the caller is a member.',
      },
      403,
    )
  let input: ReturnType<typeof requestInput>
  try {
    input = requestInput(url)
  } catch (error) {
    return json({ error: (error as Error).message }, 400)
  }
  try {
    return json(
      await (dependencies.list ?? listHostedChanges)(config.recordDatabaseUrl, who, input),
    )
  } catch (error) {
    return json({ error: (error as Error).message }, 409)
  }
}
