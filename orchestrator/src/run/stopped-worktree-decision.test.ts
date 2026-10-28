import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { stoppedWorktreeLine } from './stopped-worktree-decision.ts'

test('a kept reader clone names its temporary state and terminal remedies', () => {
  const line = stoppedWorktreeLine(
    'kept',
    '/tmp/reader-clone',
    null,
    false,
    `  coordinator is still recording  \ncleared by: ${PLATFORM_SLUG} run wait, then rerun this command`,
    '01990000-0000-7000-8000-000000000042',
    PLATFORM_SLUG,
    'found no Docker containers to reclaim',
  )

  expect(line).toBe(
    `left reader clone /tmp/reader-clone in place: coordinator is still recording; it is released by a later close-out or ${PLATFORM_SLUG} machine sweep, or by ${PLATFORM_SLUG} run discard 01990000-0000-7000-8000-000000000042; found no Docker containers to reclaim`,
  )
  expect(line).not.toContain('for continuation')
  expect(line).not.toContain('\n')
  expect(line).not.toContain('cleared by:')
})
