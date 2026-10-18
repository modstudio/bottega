import { expect, test } from 'bun:test'
import { decideHostedCommentPush } from './hosted-push-changes.ts'

const userId = '01990000-0000-7000-8000-000000001249'
const otherUserId = '01990000-0000-7000-8000-000000001247'

test('comment push authorship decision covers duplicates, ownership, and claimed authors', () => {
  const pushed = {
    id: 'comment-1',
    task_key: 'DEV-1',
    project_name: 'workshop',
    body: 'body',
    created_at: '2026-10-18T12:00:00.000Z',
    updated_at: '2026-10-18T12:00:00.000Z',
    deleted_at: null,
    actor_user_id: userId,
    actor_name: 'Person',
    agent: 'codex',
    run_id: '14372',
  }
  expect(decideHostedCommentPush(null, pushed, otherUserId)).toMatchObject({
    kind: 'reject',
    reason: expect.stringContaining('another member'),
  })
  expect(decideHostedCommentPush(pushed, pushed, otherUserId)).toEqual({ kind: 'duplicate' })
  expect(
    decideHostedCommentPush(
      { ...pushed, actor_user_id: null },
      { ...pushed, body: 'edit' },
      userId,
    ),
  ).toMatchObject({ kind: 'reject', reason: expect.stringContaining('predates') })
  expect(decideHostedCommentPush(pushed, { ...pushed, body: 'edit' }, otherUserId)).toMatchObject({
    kind: 'reject',
    reason: expect.stringContaining('another author'),
  })
  expect(decideHostedCommentPush(pushed, { ...pushed, body: 'edit' }, userId)).toEqual({
    kind: 'apply',
  })
  expect(
    decideHostedCommentPush(
      pushed,
      { ...pushed, body: 'edit', actor_name: 'Changed person' },
      userId,
    ),
  ).toMatchObject({ kind: 'reject', reason: expect.stringContaining('attribution differs') })
})
