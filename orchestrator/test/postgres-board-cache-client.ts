import { Database } from 'bun:sqlite'
import { BOARD_HOSTED_ADOPTED_KEY } from '../src/board/board-mode.ts'
import { applyMigrations } from '../src/database/migrations.ts'
import type { RecordApiClient } from '../src/record/record-api-client.ts'

const headers = (token: string, spaceId: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'x-record-space': spaceId,
})

const json = async (response: Response) => (await response.json()) as Record<string, unknown>
const subjectsUnused = async (): Promise<never> => {
  throw new Error('hosted subjects are unused in the board cache proof')
}

export function postgresBoardCacheStore(session: string, project: string): Database {
  const store = new Database(':memory:')
  applyMigrations(store)
  store.query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  store
    .query(
      `INSERT INTO presence
       (session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude','architect','machine-b',?,'/tmp',NULL,?,?)`,
    )
    .run(session, project, '2026-10-05T00:00:00.000Z', '2098-01-01T00:00:00.000Z')
  return store
}

export function postgresBoardCacheClient(
  origin: string,
  token: string,
  spaceId: string,
): RecordApiClient {
  return {
    whoami: async () =>
      json(await fetch(`${origin}/v1/whoami`, { headers: headers(token, spaceId) })),
    listBoardChanges: async ({
      after,
      limit,
    }: Parameters<RecordApiClient['listBoardChanges']>[0]) =>
      json(
        await fetch(`${origin}/v1/board/changes?after=${after ?? '0'}&limit=${limit ?? 100}`, {
          headers: headers(token, spaceId),
        }),
      ),
    putBoardReceipt: async (body: Parameters<RecordApiClient['putBoardReceipt']>[0]) =>
      json(
        await fetch(`${origin}/v1/board/receipts`, {
          method: 'PUT',
          headers: headers(token, spaceId),
          body: JSON.stringify(body),
        }),
      ),
    listProjectSubjects: subjectsUnused,
    addProjectSubject: subjectsUnused,
    renameProjectSubject: subjectsUnused,
    defineProjectSubject: subjectsUnused,
    reorderProjectSubjects: subjectsUnused,
    retireProjectSubject: subjectsUnused,
  } as unknown as RecordApiClient
}
