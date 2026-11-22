import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CANON_MIRROR_JOB } from '../run/synthetic-lifecycle-job.ts'
import {
  assertPullRequestTaskCursorAdmission,
  decidePullRequestTaskCursorAdmission,
} from './task-cursor-admission.ts'

const input = {
  command: 'pr create' as const,
  project: 'alpha',
  taskKey: 'DEV-2387',
  harnessSession: 'session-a',
  systemJob: null,
  branch: 'DEV-2387-change',
  canonMirrorBranch: 'DEV-1007-canon-mirror',
  heldCursors: [] as Array<{
    number: number
    project: string
    workflowSlug: string
    workflowKey: string
    stepSlug: string
    actions: string[]
  }>,
}

const cursor = (number: number, stepSlug: string, actions: string[], workflowKey = 'DEV-2387') => ({
  number,
  project: 'alpha',
  workflowSlug: 'fix-defect',
  workflowKey,
  stepSlug,
  actions,
})

describe('pull-request task cursor admission', () => {
  test('admits pull-request verbs only at a step that declares their action', () => {
    expect(
      decidePullRequestTaskCursorAdmission({
        ...input,
        heldCursors: [cursor(1212, 'open-pr', ['pr-create'])],
      }),
    ).toEqual({ kind: 'allow' })
    expect(
      decidePullRequestTaskCursorAdmission({
        ...input,
        command: 'pr merge',
        heldCursors: [cursor(1212, 'merge-pr', ['pr-merge'])],
      }),
    ).toEqual({ kind: 'allow' })
    expect(
      decidePullRequestTaskCursorAdmission({
        ...input,
        command: 'pr merge',
        heldCursors: [cursor(1212, 'open-pr', ['pr-create'])],
      }).kind,
    ).toBe('refuse')
  })

  test.each(['pr create', 'pr merge'] as const)(
    'refuses %s before its step and names the cursor, workflow, step, and next remedy',
    (command) => {
      const decision = decidePullRequestTaskCursorAdmission({
        ...input,
        command,
        heldCursors: [cursor(1212, 'apply-findings', [])],
      })
      expect(decision.kind).toBe('refuse')
      if (decision.kind === 'refuse') {
        expect(decision.message).toContain(
          `refusing ${PLATFORM_SLUG} ${command}: cursor 1212 (fix-defect, DEV-2387) is at step apply-findings`,
        )
        expect(decision.message).toContain(
          `${PLATFORM_SLUG} workflow next fix-defect --cursor 1212 --project alpha --arg key=DEV-2387`,
        )
      }
    },
  )

  test('admits several matching cursors when any current step declares the action', () => {
    expect(
      decidePullRequestTaskCursorAdmission({
        ...input,
        command: 'pr merge',
        heldCursors: [cursor(1212, 'apply-findings', []), cursor(1213, 'merge-pr', ['pr-merge'])],
      }),
    ).toEqual({ kind: 'allow' })
  })

  test('refuses several matching cursors and names each when none declares the action', () => {
    const decision = decidePullRequestTaskCursorAdmission({
      ...input,
      command: 'pr merge',
      heldCursors: [cursor(1212, 'apply-findings', []), cursor(1213, 'open-pr', ['pr-create'])],
    })
    expect(decision.kind).toBe('refuse')
    if (decision.kind === 'refuse') {
      expect(decision.message).toContain('cursor 1212 (fix-defect, DEV-2387)')
      expect(decision.message).toContain('cursor 1213 (fix-defect, DEV-2387)')
      expect(decision.message).toContain('--cursor 1212')
      expect(decision.message).toContain('--cursor 1213')
    }
  })

  test('refuses a different cursor and names workflow compose', () => {
    const decision = decidePullRequestTaskCursorAdmission({
      ...input,
      command: 'pr merge',
      heldCursors: [cursor(1212, 'merge-pr', ['pr-merge'], 'DEV-1')],
    })
    expect(decision.kind).toBe('refuse')
    if (decision.kind === 'refuse') {
      expect(decision.message).toContain(`refusing ${PLATFORM_SLUG} pr merge`)
      expect(decision.message).toContain(`${PLATFORM_SLUG} workflow compose ship-task`)
      expect(decision.message).toContain('--arg key=DEV-2387')
    }
  })

  test('allows a non-harness caller', () => {
    expect(
      decidePullRequestTaskCursorAdmission({
        ...input,
        harnessSession: null,
        heldCursors: [cursor(1212, 'apply-findings', [])],
      }),
    ).toEqual({ kind: 'allow' })
  })

  test('allows the system canon mirror without a held cursor but still refuses ordinary task work', () => {
    expect(
      decidePullRequestTaskCursorAdmission({
        ...input,
        taskKey: 'DEV-1007',
        systemJob: CANON_MIRROR_JOB,
        branch: 'DEV-1007-canon-mirror',
      }),
    ).toEqual({ kind: 'allow' })
    expect(
      decidePullRequestTaskCursorAdmission({
        ...input,
        taskKey: 'DEV-2581',
        systemJob: CANON_MIRROR_JOB,
        branch: 'DEV-2581-change',
      }).kind,
    ).toBe('refuse')
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
      return [cursor(1212, 'open-pr', ['pr-create'])]
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
