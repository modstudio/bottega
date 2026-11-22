import { expect, test } from 'bun:test'
import { BOARD_BODY_MAX_CHARS } from '../board/board-policy.ts'
import { hostedBoardFilingFailRefusal } from './record-board-message-refusal.ts'

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
    'board filing failure contains secret-shaped text (assignment); remove the credential and retry',
  )
  expect(secretRefusal).not.toContain(secret)
  for (const task of [
    '--arg key=DEV-1007',
    'bottega workflow compose fix-defect --arg key=DEV-1007 --arg branch=x',
    'key=STO-1349 and more',
    'remedy: --arg key=DEV-2568 --arg worktree=/tmp/x',
  ])
    expect(hostedBoardFilingFailRefusal(task)).toBeNull()
  expect(hostedBoardFilingFailRefusal('api_key=ghp_123456789012345678901234567890123456')).toBe(
    'board filing failure contains secret-shaped text (assignment); remove the credential and retry',
  )
  expect(
    hostedBoardFilingFailRefusal(
      '--arg token=ghp_123456789012345678901234567890123456 --arg x=y',
    ),
  ).toBe(
    'board filing failure contains secret-shaped text (assignment); remove the credential and retry',
  )
  const hex = '0123456789abcdef0123456789abcdef01234567'
  expect(hostedBoardFilingFailRefusal(hex)).toBe(
    'board filing failure contains secret-shaped text (hex-run); a 32+ hex run looks like a credential; if it is a commit hash, abbreviate it to 12 characters',
  )
})
