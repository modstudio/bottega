import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { BOARD_BODY_MAX_CHARS } from '../board/board-policy.ts'
import { hostedBoardFilingFailRefusal, resolvePostingProjectId } from './record-board-messages.ts'

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

test('posting project metadata resolves only one readable unretired row', async () => {
  const projectId = '03990000-0000-7000-8000-000000000001'
  const txWith = (rows: Array<{ id: string }>) => (async () => rows) as unknown as SQL

  expect(await resolvePostingProjectId(txWith([{ id: projectId }]), 'project')).toBe(projectId)
  expect(await resolvePostingProjectId(txWith([]), 'project')).toBeNull()
  expect(
    await resolvePostingProjectId(
      txWith([{ id: projectId }, { id: `${projectId}-other` }]),
      'project',
    ),
  ).toBeNull()
})
