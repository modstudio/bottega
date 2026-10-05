import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { RecordBoardError } from './record-board-contract.ts'
import { hostedBoardStoreRefusal } from './record-board-tx.ts'

test('a raised board exception becomes a named refusal', () => {
  const error = new SQL.PostgresError('board reply scope and recipients must match thread root', {
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: 'P0001',
  })
  const refusal = hostedBoardStoreRefusal(error)
  expect(refusal).toBeInstanceOf(RecordBoardError)
  expect(refusal?.status).toBe(400)
  expect(refusal?.message).toBe('board reply scope and recipients must match thread root')
})

test('a row-level security denial becomes a named refusal', () => {
  const error = new SQL.PostgresError(
    'new row violates row-level security policy for table "board_message"',
    { code: 'ERR_POSTGRES_SERVER_ERROR', errno: 42501 as unknown as string },
  )
  const refusal = hostedBoardStoreRefusal(error)
  expect(refusal).toBeInstanceOf(RecordBoardError)
  expect(refusal?.status).toBe(400)
  expect(refusal?.message).toContain('row-level security')
})

test('a missing grant is not treated as a board refusal', () => {
  const error = new SQL.PostgresError('permission denied for table board_message', {
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: 42501 as unknown as string,
  })
  expect(hostedBoardStoreRefusal(error)).toBeNull()
})
