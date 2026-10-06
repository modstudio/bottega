import { describe, expect, test } from 'bun:test'
import {
  callerIdentityRefusal,
  classifyCaller,
  resolveCallerIdentity,
  WORKER_ENVIRONMENT_MARKERS,
} from './caller-classification.ts'

describe('caller classification', () => {
  test('classifies the recognized Claude session', () => {
    expect(classifyCaller({ CLAUDE_CODE_SESSION_ID: ' claude-1 ' })).toEqual({
      kind: 'harness',
      harness: 'claude-code',
      session: 'claude-1',
    })
  })

  test('classifies an unsupported harness and a plain operator', () => {
    expect(classifyCaller({ CODEX_THREAD_ID: 'codex-1' })).toEqual({
      kind: 'unsupported-harness',
      markers: ['CODEX_THREAD_ID'],
    })
    expect(classifyCaller({})).toEqual({ kind: 'operator' })
  })

  test.each(['TERM_SESSION_ID', 'ITERM_SESSION_ID', 'XDG_SESSION_ID', 'SHELL_SESSION_ID'])(
    '%s is an ordinary terminal marker',
    (marker) => {
      expect(classifyCaller({ [marker]: 'terminal-1' })).toEqual({ kind: 'operator' })
    },
  )

  test('terminal markers neither hide unsupported harnesses nor override Claude', () => {
    expect(classifyCaller({ TERM_SESSION_ID: 'terminal-1', CODEX_THREAD_ID: 'codex-1' })).toEqual({
      kind: 'unsupported-harness',
      markers: ['CODEX_THREAD_ID'],
    })
    expect(
      classifyCaller({ TERM_SESSION_ID: 'terminal-1', CLAUDE_CODE_SESSION_ID: 'claude-1' }),
    ).toEqual({ kind: 'harness', harness: 'claude-code', session: 'claude-1' })
  })

  test('an unsupported-harness refusal names every triggering marker', () => {
    expect(
      callerIdentityRefusal(
        resolveCallerIdentity(
          classifyCaller({ OTHER_SESSION_ID: 'session-1', CODEX_THREAD_ID: 'thread-1' }),
          null,
        ),
        'score',
      ),
    ).toBe(
      'this caller is an unsupported harness (CODEX_THREAD_ID, OTHER_SESSION_ID); run the command from a terminal outside that harness',
    )
  })

  test('a worker marker wins over every harness and operator marker', () => {
    expect(
      classifyCaller({
        ORCH_DEPTH: '1',
        CLAUDE_CODE_SESSION_ID: 'claude-1',
        CODEX_THREAD_ID: 'codex-1',
      }),
    ).toEqual({ kind: 'worker' })
  })

  test.each([...WORKER_ENVIRONMENT_MARKERS])('%s alone identifies a worker', (marker: string) => {
    expect(classifyCaller({ [marker]: 'set' })).toEqual({ kind: 'worker' })
  })

  test('worker remnants win after the ordinary run and depth markers are removed', () => {
    const fullWorker = Object.fromEntries(WORKER_ENVIRONMENT_MARKERS.map((key) => [key, 'set']))
    delete fullWorker.ORCH_RUN_ID
    delete fullWorker.ORCH_DEPTH
    expect(classifyCaller(fullWorker)).toEqual({ kind: 'worker' })
  })

  test('the operator identity prefix is reserved from harness sessions', () => {
    const caller = classifyCaller({ CLAUDE_CODE_SESSION_ID: 'operator:machine-id' })
    expect(caller).toEqual({ kind: 'reserved-operator-session' })
    expect(resolveCallerIdentity(caller, 'machine-id')).toEqual({
      kind: 'no-identity',
      reason: 'reserved-operator-prefix',
    })
  })

  test('an operator without a stored machine id has a named no-identity reason', () => {
    expect(resolveCallerIdentity(classifyCaller({}), null)).toEqual({
      kind: 'no-identity',
      reason: 'operator-machine-id-missing',
    })
  })
})
