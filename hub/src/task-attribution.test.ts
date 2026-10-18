import { describe, expect, test } from 'bun:test'
import { attributionFromInputs, mayChangeComment } from './task-attribution.ts'

describe('task attribution', () => {
  test('resolves delegated runs, harness sessions, record users, and machine users from supplied values', () => {
    expect(
      attributionFromInputs({
        env: { ORCH_RUN_ID: '42', ORCH_AGENT: 'codex' },
        user: { id: 'user-1', name: 'Sam' },
        machineUser: 'local',
      }),
    ).toEqual({ actorUserId: 'user-1', actorName: 'Sam', agent: 'codex', runId: '42' })
    expect(
      attributionFromInputs({
        env: { CLAUDE_CODE_SESSION_ID: 'session-1' },
        user: null,
        machineUser: 'local',
      }),
    ).toEqual({ actorUserId: null, actorName: 'local', agent: 'claude-code', runId: null })
    expect(attributionFromInputs({ env: {}, user: null, machineUser: 'local' })).toEqual({
      actorUserId: null,
      actorName: 'local',
      agent: null,
      runId: null,
    })
  })

  test('author rule covers record authors, legacy comments, and a machine without a record', () => {
    expect(mayChangeComment('user-1', 'user-1')).toBeTrue()
    expect(mayChangeComment('user-1', 'user-2')).toBeFalse()
    expect(mayChangeComment(null, 'user-1')).toBeFalse()
    expect(mayChangeComment(null, null)).toBeTrue()
    expect(mayChangeComment('user-1', null)).toBeTrue()
  })
})
