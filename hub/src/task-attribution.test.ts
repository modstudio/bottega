import { describe, expect, test } from 'bun:test'
import { attributionFromInputs, commentAuthorDecision } from './task-attribution.ts'
import { machineAttribution } from './task-machine-attribution.ts'

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

  test('author rule distinguishes local authority, known members, and an unresolved member', () => {
    expect(commentAuthorDecision('local-authoritative', null, 'user-1')).toEqual({ allowed: true })
    expect(commentAuthorDecision('local-authoritative', null, null)).toEqual({ allowed: true })
    expect(commentAuthorDecision('hosted-configured', 'user-1', 'user-1')).toEqual({
      allowed: true,
    })
    expect(commentAuthorDecision('hosted-configured', 'user-2', 'user-1')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('another author'),
    })
    expect(commentAuthorDecision('hosted-configured', 'user-1', null)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('predates recorded authorship'),
    })
    expect(commentAuthorDecision('hosted-configured', null, 'user-1')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('record sign-in'),
    })
  })

  test('machine attribution caches resolved users and failures for sixty seconds', async () => {
    let calls = 0
    const signedInUser = async () => {
      calls++
      throw new Error('offline')
    }
    const input = {
      env: { HUB_HOSTED_URL: 'https://record.example' },
      machineUser: 'local',
      signedInUser,
    }
    expect(await machineAttribution({ ...input, now: 1 })).toMatchObject({
      actorUserId: null,
      actorName: 'local',
    })
    expect(await machineAttribution({ ...input, now: 59_999 })).toMatchObject({ actorUserId: null })
    expect(calls).toBe(1)
    await machineAttribution({ ...input, now: 60_001 })
    expect(calls).toBe(2)

    calls = 0
    const resolvedInput = {
      env: { HUB_HOSTED_URL: 'https://another-record.example' },
      machineUser: 'local',
      signedInUser: async () => {
        calls++
        return { id: 'user-1', name: 'Sam' }
      },
    }
    expect(await machineAttribution({ ...resolvedInput, now: 1 })).toMatchObject({
      actorUserId: 'user-1',
      actorName: 'Sam',
    })
    expect(await machineAttribution({ ...resolvedInput, now: 60_000 })).toMatchObject({
      actorUserId: 'user-1',
    })
    expect(calls).toBe(1)
  })
})
