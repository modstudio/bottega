import { describe, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db, sessionId } from '../db.ts'
import { adoptRunMutation, authorizeRunMutation } from './run-authority.ts'

describe('session identity is the primary id only', () => {
  const restoreSessionEnv = (claude: string | undefined, bridge: string | undefined) => {
    if (claude === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = claude
    if (bridge === undefined) delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    else process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = bridge
  }

  test('primary set returns that id', () => {
    const claude = process.env.CLAUDE_CODE_SESSION_ID
    const bridge = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    try {
      process.env.CLAUDE_CODE_SESSION_ID = 'primary-session'
      process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = 'shared-bridge'
      expect(sessionId()).toBe('primary-session')
    } finally {
      restoreSessionEnv(claude, bridge)
    }
  })

  test('only the bridge id is null and cannot adopt', () => {
    const claude = process.env.CLAUDE_CODE_SESSION_ID
    const bridge = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    try {
      delete process.env.CLAUDE_CODE_SESSION_ID
      process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = 'shared-bridge'
      expect(sessionId()).toBeNull()
      for (const action of [
        'answer',
        'tell',
        'stop',
        'abandon',
        'discard',
        'void',
        'continue',
        'score',
        'retry',
        'receipt',
      ] as const) {
        const id = addRun({ agent: 'codex', job: 'implement' })
        expect(() => adoptRunMutation(authorizeRunMutation(id, action), action)).toThrow(
          'CLAUDE_CODE_SESSION_ID',
        )
      }
    } finally {
      restoreSessionEnv(claude, bridge)
    }
  })

  test('neither variable yields null', () => {
    const claude = process.env.CLAUDE_CODE_SESSION_ID
    const bridge = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    try {
      delete process.env.CLAUDE_CODE_SESSION_ID
      delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
      expect(sessionId()).toBeNull()
    } finally {
      restoreSessionEnv(claude, bridge)
    }
  })
})

describe('who may judge a run', () => {
  test('a missing caller identity satisfies no owned mutation gate', () => {
    const id = addRun({ agent: 'codex', job: 'implement', session: 'owner-session' })
    const claude = process.env.CLAUDE_CODE_SESSION_ID
    const bridge = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    delete process.env.CLAUDE_CODE_SESSION_ID
    delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
    try {
      for (const action of [
        'answer',
        'tell',
        'stop',
        'abandon',
        'discard',
        'void',
        'retry',
        'continue',
      ] as const) {
        expect(() => authorizeRunMutation(id, action)).toThrow(
          'current session no session identity is present',
        )
      }
    } finally {
      if (claude === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = claude
      if (bridge === undefined) delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
      else process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = bridge
    }
  })

  test('each authoritative action adopts once, then refuses another session', () => {
    const prior = process.env.CLAUDE_CODE_SESSION_ID
    try {
      for (const action of [
        'answer',
        'tell',
        'stop',
        'abandon',
        'discard',
        'void',
        'continue',
        'score',
        'retry',
        'receipt',
      ] as const) {
        const id = addRun({ agent: 'codex', job: 'implement' })
        process.env.CLAUDE_CODE_SESSION_ID = 'session-A'
        const adopted = adoptRunMutation(authorizeRunMutation(id, action), action)
        expect(adopted.owner).toBe('session-A')
        expect(
          db()
            .query('SELECT action, actor_session, reason FROM run_mutation_audit WHERE run_id=?')
            .get(id),
        ).toEqual({
          action: 'adopt',
          actor_session: 'session-A',
          reason: `before ${action}`,
        })

        process.env.CLAUDE_CODE_SESSION_ID = 'session-B'
        expect(() => authorizeRunMutation(id, action)).toThrow(
          `run ${id} is owned by session session-A`,
        )
      }
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = prior
    }
  })
})
