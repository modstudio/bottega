import type { PGlite } from '@electric-sql/pglite'
import { recordRequestHeaders } from '../../../shared/record-request-headers.ts'
import { type RecordApiClient, recordApiClientOver } from '../../src/record/record-api-client.ts'
import { recordApiError } from '../../src/record/record-api-client-error.ts'
import type { RecordClientRequest } from '../../src/record/record-api-client-paths.ts'
import type { RecordIdentity } from '../../src/record/record-auth.ts'
import { takeHostedBoardClaim } from '../../src/record/record-board-claims.ts'
import { countRecordCacheRows } from '../../src/record/record-cache-counts.ts'
import { countRecordDocs } from '../../src/record/record-docs.ts'
import { readRecordQuestions } from '../../src/record/record-question-read.ts'
import { writeRecordQuestion } from '../../src/record/record-question-write.ts'
import {
  listRecordTaskFlowStages,
  readRecordTaskFlow,
  readRecordTaskFlowStage,
  readRecordTaskFlowText,
} from '../../src/record/record-task-flow.ts'
import { writeRecordTaskFlow } from '../../src/record/record-task-flow-write.ts'
import { createHostedRecordFixture, pgliteSql } from './hosted-record.ts'
import {
  createMemoryRecordApiClient,
  idleRecordApiDeps,
  idleSubjectDeps,
  installRecordApiClient,
} from './record-api.ts'
import { recordApiTestApp } from './record-api-app.ts'
import { installRecordPool } from './record-pool-injection.ts'

const RECORD_CONTRACT_URL = 'postgres://record-contract.test/record'
export const RECORD_CONTRACT_SPACE_A = '01990000-0000-7000-8000-000000024560'
export const RECORD_CONTRACT_SPACE_B = '01990000-0000-7000-8000-000000024561'
export const RECORD_CONTRACT_USER = '01990000-0000-7000-8000-000000024562'

export type RecordContractFixture = {
  app: ReturnType<typeof recordApiTestApp>
  client: RecordApiClient
  database: PGlite
  requestedRoutes: Set<string>
  requests: Array<{ path: string; destinationSpaceId: string | null }>
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

export async function createRecordContractFixture(
  options: { identity?: RecordIdentity } = {},
): Promise<RecordContractFixture> {
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
  const app = recordApiTestApp(
    options.identity ?? identity(),
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    {
      recordUrl: RECORD_CONTRACT_URL,
      readQuestions: readRecordQuestions,
      writeQuestion: writeRecordQuestion,
      readTaskFlow: readRecordTaskFlow,
      readTaskFlowStage: readRecordTaskFlowStage,
      readTaskFlowText: readRecordTaskFlowText,
      listTaskFlowStages: listRecordTaskFlowStages,
      writeTaskFlow: writeRecordTaskFlow,
      takeBoardClaim: takeHostedBoardClaim,
      countCacheRows: countRecordCacheRows,
      countDocs: countRecordDocs,
    },
  )
  const requestedRoutes = new Set<string>()
  const requests: Array<{ path: string; destinationSpaceId: string | null }> = []
  installRecordApiClient(null)
  const request: RecordClientRequest = async <T>(
    path: string,
    init?: Parameters<RecordClientRequest>[1],
  ) => {
    const requestInit = init ?? {}
    const pathname = path
      .split('?', 1)[0]!
      .replace(/^\/v1\/task-flow\/stages\/[^/]+$/, '/v1/task-flow/stages/:id')
      .replace(/^\/v1\/task-flow\/texts\/[^/]+$/, '/v1/task-flow/texts/:id')
    requestedRoutes.add(`${requestInit.method?.toUpperCase() ?? 'GET'} ${pathname}`)
    requests.push({
      path: `${requestInit.method?.toUpperCase() ?? 'GET'} ${path}`,
      destinationSpaceId: requestInit.destinationSpaceId ?? null,
    })
    const headers = recordRequestHeaders({
      destinationSpaceId: requestInit.destinationSpaceId,
      headers: requestInit.headers,
    })
    if (requestInit.body && !headers.has('content-type'))
      headers.set('content-type', 'application/json')
    const response = await app.request(path, { ...requestInit, headers })
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      if (requestInit.acceptedError?.status === response.status)
        return requestInit.acceptedError.schema(body) as T
      throw recordApiError(body, response.status, response.headers)
    }
    return requestInit.schema ? (requestInit.schema(body) as T) : (body as T)
  }
  const client = recordApiClientOver(request)
  installRecordApiClient(client)
  const close = async () => {
    installRecordApiClient(createMemoryRecordApiClient())
    restorePool()
    await database.close()
  }
  return {
    app,
    client,
    database,
    requestedRoutes,
    requests,
    close,
  }
}
