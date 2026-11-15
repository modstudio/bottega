import { describe, expect, test } from 'bun:test'
import { decideSessionStart } from './session-start-decision.ts'

describe('session start decision', () => {
  test('composes when the session holds no cursor', () => {
    expect(decideSessionStart({ session: 'session', project: 'fixture', openCursors: [] })).toEqual(
      { kind: 'compose' },
    )
  })

  test('reuses an open explore cursor', () => {
    expect(
      decideSessionStart({
        session: 'session',
        project: 'fixture',
        openCursors: [{ id: 17, workflow: 'explore', workflowKey: '' }],
      }),
    ).toEqual({ kind: 'reuse', cursor: 17, workflow: 'explore' })
  })

  test.each(['startup', 'resume', 'compact'])(
    'does nothing for %s while a task-bound cursor is open',
    () => {
      expect(
        decideSessionStart({
          session: 'session',
          project: 'fixture',
          openCursors: [{ id: 18, workflow: 'plan-task', workflowKey: 'DEV-2323' }],
        }),
      ).toEqual({ kind: 'none' })
    },
  )

  test('refuses softly without a session identity', () => {
    expect(decideSessionStart({ session: null, project: 'fixture', openCursors: [] })).toEqual({
      kind: 'refuse-session',
    })
  })

  test('refuses softly outside a registered project', () => {
    expect(decideSessionStart({ session: 'session', project: null, openCursors: [] })).toEqual({
      kind: 'refuse-project',
    })
  })
})
