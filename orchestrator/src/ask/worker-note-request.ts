// concern: worker note request lifecycle
/** DB-backed handoff from a sandbox ask server to the host run supervisor. */
import { db, nowIso, writableDb } from '../database/db.ts'
import type { WorkerNoteFiledResult, WorkerNoteInput, WorkerNoteRun } from './worker-note.ts'

const WORKER_NOTE_WAIT_MS = 30_000
const WORKER_NOTE_POLL_MS = 100

export type WorkerNoteRefusalClass = 'anchor-refused' | 'filing-refused' | 'supervisor-closed'
export type WorkerNoteOutcome =
  | ({ status: 'filed' } & WorkerNoteFiledResult)
  | { status: 'refused'; refusalClass: WorkerNoteRefusalClass; detail: string }

export function workerNoteTransition(
  current: 'requested' | 'filed' | 'refused',
  outcome: WorkerNoteOutcome,
): {
  status: 'filed' | 'refused'
  noteRecordId: string | null
  noteLabel: string | null
  candidateIds: string
  candidateLabels: string
  refusalClass: string | null
  detail: string | null
} {
  if (current !== 'requested') throw new Error(`worker note request is already ${current}`)
  return outcome.status === 'filed'
    ? {
        status: 'filed',
        noteRecordId: outcome.noteRecordId,
        noteLabel: outcome.noteLabel,
        candidateIds: JSON.stringify(outcome.candidateNotes.map((candidate) => candidate.recordId)),
        candidateLabels: JSON.stringify(outcome.candidateNotes.map((candidate) => candidate.label)),
        refusalClass: null,
        detail: outcome.anchorDropped ?? null,
      }
    : {
        status: 'refused',
        noteRecordId: null,
        noteLabel: null,
        candidateIds: '[]',
        candidateLabels: '[]',
        refusalClass: outcome.refusalClass,
        detail: outcome.detail,
      }
}

function workerNoteRefusalMessage(refusalClass: string | null): string {
  if (refusalClass === 'anchor-refused')
    return 'The note was not filed (the file anchor was refused by the host).'
  if (refusalClass === 'supervisor-closed')
    return 'The note was not filed (the supervising run ended before filing completed).'
  return 'The note was not filed (the host note service refused the request).'
}

export async function requestWorkerNote(
  run: WorkerNoteRun,
  input: WorkerNoteInput,
): Promise<WorkerNoteFiledResult> {
  writableDb()
  const request = db()
    .query(
      `INSERT INTO worker_note_request (run_id,text,file,same_as,requested_at,status)
       VALUES (?,?,?,?,?,'requested') RETURNING id`,
    )
    .get(run.id, input.text, input.file ?? null, input.sameAs ?? null, nowIso()) as { id: number }
  const deadline = Date.now() + WORKER_NOTE_WAIT_MS
  while (Date.now() < deadline) {
    const row = db()
      .query(
        `SELECT status,note_record_id,note_label,candidate_ids,candidate_labels,refusal_class,detail
         FROM worker_note_request WHERE id=?`,
      )
      .get(request.id) as {
      status: 'requested' | 'filed' | 'refused'
      note_record_id: string | null
      note_label: string | null
      candidate_ids: string
      candidate_labels: string
      refusal_class: string | null
      detail: string | null
    } | null
    if (!row) throw new Error('The note was not filed (the request record disappeared).')
    if (row.status === 'filed' && row.note_record_id && row.note_label) {
      const ids = JSON.parse(row.candidate_ids) as string[]
      const labels = JSON.parse(row.candidate_labels) as string[]
      return {
        noteRecordId: row.note_record_id,
        noteLabel: row.note_label,
        candidateNotes: ids.map((recordId, index) => ({ recordId, label: labels[index]! })),
        ...(row.detail ? { anchorDropped: row.detail } : {}),
      }
    }
    if (row.status === 'refused') throw new Error(workerNoteRefusalMessage(row.refusal_class))
    await Bun.sleep(WORKER_NOTE_POLL_MS)
  }
  throw new Error('The note was not filed (the host did not respond within the bounded wait).')
}
