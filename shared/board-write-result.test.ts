import { expect, test } from 'bun:test'
import { type BoardWriteDropped, hostedBoardWriteResult } from './board-write-result.ts'

// @ts-expect-error Board write results cannot assign `dropped` from a literal.
const literalDropped: BoardWriteDropped = false
void literalDropped

const mintedId = '01990000-0000-7000-8000-000000000001'
const duplicateId = '01990000-0000-7000-8000-000000000002'

test('hosted board write results distinguish retries and duplicate response versions', () => {
  expect(hostedBoardWriteResult(mintedId, { id: mintedId, duplicateOf: null })).toEqual({
    dropped: false,
    duplicateOf: null,
  })
  expect(hostedBoardWriteResult(mintedId, { id: mintedId })).toEqual({
    dropped: false,
    duplicateOf: null,
  })
  expect(hostedBoardWriteResult(mintedId, { id: duplicateId, duplicateOf: duplicateId })).toEqual({
    dropped: true,
    duplicateOf: duplicateId,
  })
  expect(hostedBoardWriteResult(mintedId, { id: duplicateId })).toEqual({
    dropped: true,
    duplicateOf: duplicateId,
  })
})
