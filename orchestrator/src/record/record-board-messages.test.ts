import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BOARD_BODY_MAX_CHARS } from '../board/board-policy.ts'
import { hostedBoardFilingFailRefusal } from './record-board-messages.ts'

test('filing-fail error is bounded and refused when secret-shaped without echoing the text', () => {
  expect(hostedBoardFilingFailRefusal('hub unavailable')).toBeNull()
  expect(hostedBoardFilingFailRefusal('   ')).toBe('filing failure error is required')
  const tooLong = 'x'.repeat(BOARD_BODY_MAX_CHARS + 1)
  const lengthRefusal = hostedBoardFilingFailRefusal(tooLong)
  expect(lengthRefusal).toBe(
    `board filing failure exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`,
  )
  expect(lengthRefusal).not.toContain(tooLong)
  const secret = 'password=supersecretvalue'
  const secretRefusal = hostedBoardFilingFailRefusal(secret)
  expect(secretRefusal).toBe(
    'board filing failure contains secret-shaped text; remove the credential and retry',
  )
  expect(secretRefusal).not.toContain(secret)
})

test('hosted board change rows resolve the stored author project name', () => {
  const source = readFileSync(resolve(import.meta.dir, 'record-board-changes.ts'), 'utf8')
  expect(source).toContain(
    'SELECT board_message.*, project.name AS author_project_name FROM board_message',
  )
  expect(source).toContain('LEFT JOIN project ON project.id=board_message.author_project_id')
})
