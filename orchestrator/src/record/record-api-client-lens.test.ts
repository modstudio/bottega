import { expect, test } from 'bun:test'
import { recordLensClient } from './record-api-client-lens.ts'

test('lens catalogue client refuses a malformed response body', async () => {
  const client = recordLensClient(async (_path, init) =>
    init!.schema!({ items: [{ id: 1 }], nextCursor: null }),
  )
  await expect(client.listLensCatalogue('lens', {})).rejects.toThrow()
})
