import type { RecordApiClient } from '../src/record/record-api-client.ts'

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
})

const json = async (response: Response) => (await response.json()) as Record<string, unknown>

export function postgresBoardCacheClient(origin: string, token: string): RecordApiClient {
  return {
    whoami: async () => json(await fetch(`${origin}/v1/whoami`, { headers: headers(token) })),
    listBoardChanges: async ({
      after,
      limit,
    }: Parameters<RecordApiClient['listBoardChanges']>[0]) =>
      json(
        await fetch(`${origin}/v1/board/changes?after=${after ?? '0'}&limit=${limit ?? 100}`, {
          headers: headers(token),
        }),
      ),
    putBoardReceipt: async (body: Parameters<RecordApiClient['putBoardReceipt']>[0]) =>
      json(
        await fetch(`${origin}/v1/board/receipts`, {
          method: 'PUT',
          headers: headers(token),
          body: JSON.stringify(body),
        }),
      ),
  } as unknown as RecordApiClient
}
