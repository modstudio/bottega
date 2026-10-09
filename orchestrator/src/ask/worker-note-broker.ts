// concern: worker note broker
/** Host-side filing of note requests recorded by sandboxed ask servers. */
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { fileWorkerNote, type WorkerNoteRun } from './worker-note.ts'
import {
  type WorkerNoteOutcome,
  type WorkerNoteRefusalClass,
  workerNoteTransition,
} from './worker-note-request.ts'

const WORKER_NOTE_POLL_MS = 100
type PendingNote = {
  id: number
  run_id: number
  text: string
  project: string | null
  file: string | null
  same_as: string | null
}

function storeContention(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown }
  return (
    candidate?.code === 'SQLITE_BUSY' ||
    candidate?.code === 'SQLITE_LOCKED' ||
    /database (?:table )?is locked/i.test(String(candidate?.message))
  )
}

function claim(runId: number): PendingNote | null {
  return writeTransaction(() => {
    const row = db()
      .query(
        `SELECT id,run_id,text,project,file,same_as FROM worker_note_request
         WHERE run_id=? AND status='requested' AND claimed_at IS NULL ORDER BY id LIMIT 1`,
      )
      .get(runId) as PendingNote | null
    if (!row) return null
    const changed = db()
      .query(`UPDATE worker_note_request SET claimed_at=? WHERE id=? AND claimed_at IS NULL`)
      .run(nowIso(), row.id)
    return changed.changes === 1 ? row : null
  })
}

function runFacts(runId: number): WorkerNoteRun {
  const row = db()
    .query(
      `SELECT r.id,p.name AS project,p.path AS project_path,COALESCE(r.worktree,r.cwd) AS tree,
              r.branch,r.session_id,r.head_commit
       FROM run r JOIN project p ON p.id=r.project_id WHERE r.id=?`,
    )
    .get(runId) as {
    id: number
    project: string
    project_path: string
    tree: string | null
    branch: string | null
    session_id: string | null
    head_commit: string | null
  } | null
  if (!row) throw new Error(`run ${runId} has no registered project`)
  if (!row.tree) throw new Error(`run ${runId} has no run tree`)
  return {
    id: row.id,
    project: row.project,
    projectPath: row.project_path,
    tree: row.tree,
    branch: row.branch,
    sessionId: row.session_id,
    headCommit: row.head_commit,
  }
}

function refusalClass(error: unknown): WorkerNoteRefusalClass {
  const detail = String(error)
  return /File anchor|run tree|symbolic link|hard link|regular file/.test(detail)
    ? 'anchor-refused'
    : 'filing-refused'
}

function finish(request: PendingNote, outcome: WorkerNoteOutcome): void {
  const update = workerNoteTransition('requested', outcome)
  db()
    .query(
      `UPDATE worker_note_request SET status=?,finished_at=?,note_record_id=?,note_label=?,
       candidate_ids=?,candidate_labels=?,refusal_class=?,detail=?
       WHERE id=? AND status='requested'`,
    )
    .run(
      update.status,
      nowIso(),
      update.noteRecordId,
      update.noteLabel,
      update.candidateIds,
      update.candidateLabels,
      update.refusalClass,
      update.detail,
      request.id,
    )
}

type WorkerNoteFiler = typeof fileWorkerNote

async function file(request: PendingNote, filer: WorkerNoteFiler): Promise<void> {
  let outcome: WorkerNoteOutcome
  try {
    const filed = await filer(runFacts(request.run_id), {
      text: request.text,
      ...(request.project ? { project: request.project } : {}),
      ...(request.file ? { file: request.file } : {}),
      ...(request.same_as ? { sameAs: request.same_as } : {}),
    })
    outcome = { status: 'filed', ...filed }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    outcome = { status: 'refused', refusalClass: refusalClass(error), detail }
    appendRunEvent(request.run_id, {
      ts: nowIso(),
      type: 'text',
      text: `worker note request ${request.id} was refused: ${detail}`,
    })
  }
  try {
    finish(request, outcome)
  } catch (error) {
    appendRunEvent(request.run_id, {
      ts: nowIso(),
      type: 'text',
      text: `worker note request ${request.id} could not record its result: ${String(error)}`,
    })
  }
}

export type WorkerNoteBroker = { close(): Promise<void> }

export function startWorkerNoteBroker(
  runId: number,
  filer: WorkerNoteFiler = fileWorkerNote,
): WorkerNoteBroker {
  let closed = false
  let stopped = false
  let active: Promise<void> | null = null
  const poll = () => {
    if (closed || stopped || active) return
    let request: PendingNote | null
    try {
      request = claim(runId)
    } catch (error) {
      if (!storeContention(error)) {
        stopped = true
        clearInterval(timer)
        appendRunEvent(runId, {
          ts: nowIso(),
          type: 'text',
          text: `worker note broker stopped after claim failure: ${String(error)}`,
        })
      }
      return
    }
    if (!request) return
    const operation = file(request, filer)
    active = operation
    void operation.finally(() => {
      if (active === operation) active = null
    })
  }
  const timer = setInterval(poll, WORKER_NOTE_POLL_MS)
  poll()
  return {
    async close() {
      closed = true
      clearInterval(timer)
      if (active) await active
      db()
        .query(
          `UPDATE worker_note_request SET status='refused',finished_at=?,
           refusal_class='supervisor-closed',detail='run supervisor closed before filing'
           WHERE run_id=? AND status='requested'`,
        )
        .run(nowIso(), runId)
    },
  }
}
