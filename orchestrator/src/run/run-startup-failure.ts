// concern: run-startup-failure
/** Records and publishes startup failures before or after a run is claimed. */
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { rollUpRootAndEnqueue } from './run-liveness.ts'
import { nextRunNumber } from './run-number.ts'
import { enqueueRunRecord } from './run-outbox.ts'
import { assertRunHasTaskOrProject, resolveNewRunLinks } from './run-task-reference.ts'

function enqueueFailedReservedRun(
  reserveId: string,
  database: ReturnType<typeof db>,
  localMachineId: string,
  finishedAt: string,
): void {
  const reserved = database
    .query('SELECT parent_run_record_id FROM run WHERE record_id=?')
    .get(reserveId) as { parent_run_record_id: string | null } | null
  enqueueRunRecord(database, reserveId, localMachineId, finishedAt)
  if (reserved?.parent_run_record_id)
    rollUpRootAndEnqueue(database, reserved.parent_run_record_id, null, localMachineId, finishedAt)
}

export function publishFailedReservedRun(reserveId: string): void {
  const finishedAt = nowIso()
  const localMachineId = machineId()
  writeTransaction(() => {
    const database = db()
    const failed = database
      .query("SELECT 1 AS failed FROM run WHERE record_id=? AND status='failed'")
      .get(reserveId)
    if (failed) enqueueFailedReservedRun(reserveId, database, localMachineId, finishedAt)
  })
}

export function recordRunStartupFailure(
  reserveId: string | undefined,
  error: unknown,
  started?: number,
  options?: { failureKind?: string; mcpError?: string },
): void {
  if (!reserveId) return
  const message = error instanceof Error ? error.message : String(error)
  const finishedAt = nowIso()
  const localMachineId = machineId()
  writeTransaction(() => {
    const database = db()
    const changed = database
      .query(
        `UPDATE run SET status='failed', failure_kind=?, error=?,
         mcp_error=COALESCE(?,mcp_error), latency_ms=?
         WHERE record_id=? AND status='running'`,
      )
      // Keep this status predicate paired with exec.ts's self-contained fallback.
      .run(
        options?.failureKind ?? 'harness',
        message,
        options?.mcpError ?? null,
        started === undefined ? 0 : Date.now() - started,
        reserveId,
      ).changes
    if (changed !== 1) return
    enqueueFailedReservedRun(reserveId, database, localMachineId, finishedAt)
  })
}

export function enforceRunStartupRefusal(
  reserveId: string | undefined,
  refusalReason: string | null,
): void {
  if (!refusalReason) return
  recordRunStartupFailure(reserveId, refusalReason)
  throw new Error(refusalReason)
}

export async function recordNeverStartedRunFailure(input: {
  recordId: string
  error: unknown
  job: string
  repo: string | null
  projectRecordId: string | null
  key: string | null
  cwd: string
  promptSha: string
  specSha: string
  promptBytes: number
  promptHead: string
  sessionId: string | null
  mcp: number
  startedByUserId: string | null
  agentExplicit: number
}): Promise<string> {
  const links = await resolveNewRunLinks({
    recordId: input.recordId,
    job: input.job,
    projectName: input.repo,
    projectRecordId: input.projectRecordId,
    key: input.key,
    cwd: input.cwd,
    launchCwd: input.cwd,
    probe: false,
  })
  assertRunHasTaskOrProject({
    probe: false,
    taskRecordId: links.taskRecordId,
    projectRecordId: links.projectRecordId,
  })
  const message = input.error instanceof Error ? input.error.message : String(input.error)
  const finishedAt = nowIso()
  const localMachineId = machineId()
  return writeTransaction(() => {
    const database = db()
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,repo,project_record_id,task_record_id,cwd,prompt_sha,spec_sha,
          prompt_bytes,prompt_head,status,failure_kind,error,latency_ms,session_id,docs_injected,mcp,
          started_by_user_id,agent_explicit)
         VALUES (?,?,?,'(pending)',?,?,?,?,?,?,?,?,?,'failed','harness',?,0,?,0,?,?,?)`,
      )
      .run(
        input.recordId,
        nextRunNumber(database),
        finishedAt,
        input.job,
        input.repo,
        links.projectRecordId,
        links.taskRecordId,
        input.cwd,
        input.promptSha,
        input.specSha,
        input.promptBytes,
        input.promptHead,
        message,
        input.sessionId,
        input.mcp,
        input.startedByUserId,
        input.agentExplicit,
      )
    enqueueFailedReservedRun(input.recordId, database, localMachineId, finishedAt)
    return input.recordId
  })
}
