// concern: live-run-member
/**
 * Owns the canonical current member of a run chain and its stalled-run observation.
 * Knows nothing of monitor condition shape, the CLI, killing a run, or project locks.
 */

import type { Database } from 'bun:sqlite'
import { pidRecordIdentity, processStartTime } from '../../../shared/process-identity.ts'
import { db } from '../database/db.ts'
import { idleMsSince } from '../events.ts'
import { type ProcessSample, processTreeCpuMoving } from '../idle-kill.ts'
import { jobIdleKillMs } from '../jobs/jobs.ts'
import { idleStallMs, stalledRunDetail, stalledRunState } from '../stalled-run.ts'

export type LiveRunMember = {
  id: number
  started_at: string
  last_event_at: string | null
  agent: string
  job: string
  session_id: string | null
  agent_pid: number | null
  agent_start_time: string | null
}

/** One definition of the member whose status and process represent a conversation now. */
export function currentRunMemberJoin(rootAlias: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(rootAlias)) throw new Error('invalid run query alias')
  return `JOIN run current_run ON current_run.id = (
    SELECT member.id FROM run member
     WHERE member.id = ${rootAlias}.id OR member.parent_run_id = ${rootAlias}.id
     ORDER BY member.turn DESC, member.id DESC LIMIT 1
  )`
}

/** Current running members machine-wide, retaining the root session as their owner. */
export function liveRunMembers(database: Database = db()): LiveRunMember[] {
  return database
    .query(
      `SELECT current_run.id, current_run.started_at, current_run.last_event_at,
              current_run.agent, current_run.job, root.session_id,
              current_run.agent_pid, current_run.agent_start_time
         FROM run root
         ${currentRunMemberJoin('root')}
        WHERE root.parent_run_id IS NULL AND current_run.status='running'`,
    )
    .all() as LiveRunMember[]
}

export type LiveMemberStall = {
  state: 'healthy' | 'stalled' | 'unknown'
  detail: string | null
  idleMs: number | null
  idleBoundMs: number
}

/** Observe one persisted process incarnation; absent or reused identities are unknown. */
export function liveMemberStall(
  member: LiveRunMember,
  samples: ProcessSample[],
  clock = Date.now(),
  thresholdMs = idleStallMs(),
  observedStartTime: (pid: number) => string | null = processStartTime,
): LiveMemberStall {
  const idleMs = idleMsSince(member.last_event_at, member.started_at, clock)
  const idleBoundMs = jobIdleKillMs(member.job)
  const identity = pidRecordIdentity(member.agent_pid, member.agent_start_time, observedStartTime)
  const cpuMoving =
    identity === 'live' && member.agent_pid ? processTreeCpuMoving(member.agent_pid, samples) : null
  const state = stalledRunState({ idleMs, cpuMoving, idleBoundMs, thresholdMs })
  return {
    state,
    detail:
      state === 'stalled' && idleMs !== null
        ? stalledRunDetail({ ...member, idleMs, idleBoundMs })
        : null,
    idleMs,
    idleBoundMs,
  }
}
