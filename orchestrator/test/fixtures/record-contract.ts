import type { PGlite } from '@electric-sql/pglite'
import type { Hono } from 'hono'
import { recordRequestHeaders } from '../../../shared/record-request-headers.ts'
import { recordApiClient, type RecordApiClient } from '../../src/record/record-api-client.ts'
import { recordApiError } from '../../src/record/record-api-client-error.ts'
import type { RecordIdentity } from '../../src/record/record-auth.ts'
import { takeHostedBoardClaim } from '../../src/record/record-board-claims.ts'
import {
  listRecordTaskFlowStages,
  readRecordTaskFlow,
  readRecordTaskFlowStage,
} from '../../src/record/record-task-flow.ts'
import { writeRecordTaskFlow } from '../../src/record/record-task-flow-write.ts'
import { recordApiTestApp } from './record-api-app.ts'
import {
  createMemoryRecordApiClient,
  idleRecordApiDeps,
  idleSubjectDeps,
  installRecordApiClient,
} from './record-api.ts'
import { createHostedRecordFixture, pgliteSql } from './hosted-record.ts'
import { installRecordPool } from './record-pool-injection.ts'

export const RECORD_CONTRACT_URL = 'postgres://record-contract.test/record'
export const RECORD_CONTRACT_SPACE_A = '01990000-0000-7000-8000-000000024560'
export const RECORD_CONTRACT_SPACE_B = '01990000-0000-7000-8000-000000024561'
export const RECORD_CONTRACT_USER = '01990000-0000-7000-8000-000000024562'

type ContractRequestInit = RequestInit & {
  schema?: (body: unknown) => unknown
  acceptedError?: { status: number; schema: (body: unknown) => unknown }
  destinationSpaceId?: string
}

export type RecordContractFixture = {
  app: Hono
  client: RecordApiClient
  database: PGlite
  requestedRoutes: Set<string>
  close(): Promise<void>
}

function identity(): RecordIdentity {
  return {
    user: { id: RECORD_CONTRACT_USER, email: 'contract@example.test', emailVerified: true },
    activeSpaceId: RECORD_CONTRACT_SPACE_A,
    personalSpaceId: RECORD_CONTRACT_SPACE_A,
    memberships: [
      {
        space_id: RECORD_CONTRACT_SPACE_A,
        name: 'Contract A',
        slug: 'contract-a',
        role: 'member',
        permission: 'write',
      },
      {
        space_id: RECORD_CONTRACT_SPACE_B,
        name: 'Contract B',
        slug: 'contract-b',
        role: 'member',
        permission: 'write',
      },
    ],
  }
}

export async function createRecordContractFixture(): Promise<RecordContractFixture> {
  const database = await createHostedRecordFixture({
    spaceId: RECORD_CONTRACT_SPACE_A,
    userId: RECORD_CONTRACT_USER,
  })
  await database.exec(`
    RESET ROLE;
    UPDATE space SET name='Contract A',slug='contract-a' WHERE id='${RECORD_CONTRACT_SPACE_A}';
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${RECORD_CONTRACT_SPACE_B}','Contract B','contract-b',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000024563','${RECORD_CONTRACT_SPACE_B}',
      '${RECORD_CONTRACT_USER}','member','write',now());
    SET ROLE record_actor;
  `)
  const restorePool = installRecordPool(RECORD_CONTRACT_URL, pgliteSql(database))
  const app = recordApiTestApp(identity(), { ...idleSubjectDeps(), ...idleRecordApiDeps() }, {
    recordUrl: RECORD_CONTRACT_URL,
    readTaskFlow: readRecordTaskFlow,
    readTaskFlowStage: readRecordTaskFlowStage,
    listTaskFlowStages: listRecordTaskFlowStages,
    writeTaskFlow: writeRecordTaskFlow,
    takeBoardClaim: takeHostedBoardClaim,
  })
  const requestedRoutes = new Set<string>()
  installRecordApiClient(null)
  const previousContainer = process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
  process.env.BOTTEGA_TEST_POSTGRES_CONTAINER = 'record-contract'
  const client = recordApiClient(async <T>(path: string, init: ContractRequestInit = {}) => {
    const pathname = path
      .split('?', 1)[0]!
      .replace(/^\/v1\/task-flow\/stages\/[^/]+$/, '/v1/task-flow/stages/:id')
    requestedRoutes.add(`${init.method?.toUpperCase() ?? 'GET'} ${pathname}`)
    const headers = recordRequestHeaders({
      destinationSpaceId: init.destinationSpaceId,
      headers: init.headers,
    })
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    const response = await app.request(path, { ...init, headers })
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      if (init.acceptedError?.status === response.status)
        return init.acceptedError.schema(body) as T
      throw recordApiError(body, response.status, response.headers)
    }
    return (init.schema ? init.schema(body) : body) as T
  })
  if (previousContainer === undefined) delete process.env.BOTTEGA_TEST_POSTGRES_CONTAINER
  else process.env.BOTTEGA_TEST_POSTGRES_CONTAINER = previousContainer
  installRecordApiClient(client)
  return {
    app,
    client,
    database,
    requestedRoutes,
    async close() {
      installRecordApiClient(createMemoryRecordApiClient())
      restorePool()
      await database.close()
    },
  }
}
