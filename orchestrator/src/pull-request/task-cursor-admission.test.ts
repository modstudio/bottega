import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  assertPullRequestTaskCursorAdmission,
  decidePullRequestTaskCursorAdmission,
} from './task-cursor-admission.ts'

const input = {
  command: 'pr create' as const,
  project: 'alpha',
  taskKey: 'DEV-2387',
  harnessSession: 'session-a',
  heldCursors: [] as Array<{ project: string; workflowKey: string }>,
}

describe('pull-request task cursor admission', () => {
  test('admits the session that owns the key cursor', () => {
    expect(
      decidePullRequestTaskCursorAdmission({
        ...input,
        heldCursors: [{ project: 'alpha', workflowKey: 'DEV-2387' }],
      }),
    ).toEqual({ kind: 'allow' })
  })

  test('refuses a different cursor and names workflow compose', () => {
    const decision = decidePullRequestTaskCursorAdmission({
      ...input,
      command: 'pr merge',
      heldCursors: [{ project: 'alpha', workflowKey: 'DEV-1' }],
    })
    expect(decision.kind).toBe('refuse')
    if (decision.kind === 'refuse') {
      expect(decision.message).toContain(`refusing ${PLATFORM_SLUG} pr merge`)
      expect(decision.message).toContain(`${PLATFORM_SLUG} workflow compose ship-task`)
      expect(decision.message).toContain('--arg key=DEV-2387')
    }
  })
})

const project = {
  recordId: 'project-id',
  name: 'alpha',
  path: '/projects/alpha',
  stack: null,
  canon: true,
  retiredAt: null,
  settings: { keyPrefixes: ['DEV'] },
}

test('the adapter reads the harness cursors before admitting a keyed branch', async () => {
  const sessions: string[] = []
  await assertPullRequestTaskCursorAdmission(
    {
      command: 'pr create',
      project,
      branch: 'DEV-2387-change',
      env: { CLAUDE_CODE_SESSION_ID: 'session-a' },
    },
    async (_database, session) => {
      sessions.push(session)
      return [{ project: 'alpha', workflowKey: 'DEV-2387' }]
    },
  )
  expect(sessions).toEqual(['session-a'])
})

test('the adapter refuses a keyed branch when the harness has no cursor', async () => {
  await expect(
    assertPullRequestTaskCursorAdmission(
      {
        command: 'pr merge',
        project,
        branch: 'DEV-2387-change',
        env: { CLAUDE_CODE_SESSION_ID: 'session-a' },
      },
      async () => [],
    ),
  ).rejects.toThrow(`${PLATFORM_SLUG} workflow compose ship-task`)
})
