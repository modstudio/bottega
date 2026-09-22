import { describe, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { ProcessSample } from '../idle-kill.ts'
import { type LiveRunMember, liveMemberStall, liveRunMembers } from './live-run-member.ts'

describe('live run member', () => {
  const clock = Date.parse('2026-09-22T12:30:00.000Z')
  const member: LiveRunMember = {
    id: 88,
    started_at: '2026-09-22T12:00:00.000Z',
    last_event_at: '2026-09-22T12:00:00.000Z',
    agent: 'codex',
    job: 'review-lens',
    session_id: 'session-88',
    agent_pid: process.pid,
    agent_start_time: 'recorded birth',
  }
  const idle: ProcessSample[] = [
    { pid: process.pid, ppid: 1, pgid: process.pid, cpu: 0, state: 'S' },
  ]
  const busy: ProcessSample[] = [{ ...idle[0]!, cpu: 99 }]

  test('PID reuse cannot turn an idle unrelated process into a stall', () => {
    expect(liveMemberStall(member, idle, clock, 25 * 60_000, () => 'later birth')).toMatchObject({
      state: 'unknown',
      detail: null,
    })
  })

  test('PID reuse cannot turn a busy unrelated process into a healthy verdict', () => {
    expect(liveMemberStall(member, busy, clock, 25 * 60_000, () => 'later birth')).toMatchObject({
      state: 'unknown',
      detail: null,
    })
  })

  test('a matching idle incarnation is stalled', () => {
    expect(
      liveMemberStall(member, idle, clock, 25 * 60_000, () => member.agent_start_time),
    ).toMatchObject({
      state: 'stalled',
      detail:
        'run 88 codex/review-lens has been silent for 30m and has used no CPU in that time; stop it and re-dispatch, or wait for the 29m idle bound',
    })
  })

  test('publishes the running turn, not its asking root, as the live member', () => {
    const root = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      session: 'session-chain',
    })
    const turn = addRun({
      agent: 'grok',
      job: 'review-lens',
      status: 'running',
      parent: root,
      turn: 2,
    })
    db()
      .query('UPDATE run SET agent_pid=?,agent_start_time=?,last_event_at=? WHERE id=?')
      .run(880, 'recorded birth', '2026-09-22T12:00:00.000Z', turn)

    expect(liveRunMembers()).toContainEqual({
      id: turn,
      started_at: expect.any(String),
      last_event_at: '2026-09-22T12:00:00.000Z',
      agent: 'grok',
      job: 'review-lens',
      session_id: 'session-chain',
      agent_pid: 880,
      agent_start_time: 'recorded birth',
    })
  })
})
