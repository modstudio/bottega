import { expect, test } from 'bun:test'
import { recordApiError } from './record-api-client-error.ts'
import { RecordApiRequestError } from './record-api-client-response.ts'

test('record API refusals preserve a wire error code', () => {
  const error = recordApiError(
    { error: 'hosted task flow was not found', code: 'task_flow_not_found' },
    404,
  )

  expect(error).toBeInstanceOf(RecordApiRequestError)
  expect((error as RecordApiRequestError).code).toBe('task_flow_not_found')
})
