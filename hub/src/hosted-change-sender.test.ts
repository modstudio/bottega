import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { sendHostedChanges } from './hosted-change-sender.ts'
import type { HostedPushChange } from './push-contract.ts'

const rowId = '01990000-0000-7000-8000-000000002526'
const changeId = '01990000-0000-7000-8000-000000002527'
const rejected: HostedPushChange = {
  table: 'hub_interval',
  id: rowId,
  op: 'delete',
  change_id: changeId,
}
const options = {
  baseUrl: 'https://hub.example.test',
  token: 'test',
  recordSpace: 'workshop',
  fetch: async () =>
    Response.json([{ id: rowId, status: 'rejected', reason: 'revision conflict' }]),
}

test('a rejected note change names the note and note-list remedy', async () => {
  await expect(
    sendHostedChanges('note workshop#17', [[rejected]], {
      ...options,
      conflictRemedy: `${PLATFORM_SLUG} note list --project workshop`,
    }),
  ).rejects.toThrow(
    `hosted change ${rowId} was refused: revision conflict; refresh note workshop#17 with \`${PLATFORM_SLUG} note list --project workshop\` and retry`,
  )
})

test('the task conflict refusal text remains unchanged', async () => {
  await expect(
    sendHostedChanges('the record', [[rejected]], {
      ...options,
      conflictRemedy: `${PLATFORM_SLUG} task show DEV-2526`,
    }),
  ).rejects.toThrow(
    `hosted change ${rowId} was refused: revision conflict; refresh the record with \`${PLATFORM_SLUG} task show DEV-2526\` and retry`,
  )
})
