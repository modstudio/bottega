import type { Database } from 'bun:sqlite'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { NoteAnchorWire } from '../../shared/note-anchor.ts'
import { parseNoteAnchorWire } from '../../shared/note-anchor.ts'
import { formatNoteLabel } from '../../shared/note-label.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { hasRecordIdShape } from '../../shared/record-id.ts'
import { projectOf } from './attribute.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import { HostedChangeStageError, sendHostedChanges } from './hosted-change-sender.ts'
import { applyHostedWriteLocally } from './hosted-local-apply.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import {
  hostedUnavailableRemedy,
  hostedWriteMode,
  projectWriteDecisionFor,
} from './hosted-write-mode.ts'
import { resolveNoteIdentity } from './identity/identity.ts'
import { readInstallBinding } from './install-binding.ts'
import { mergeNoteAnchors } from './note-anchor-merge.ts'
import { applyHostedNote } from './note-cache.ts'
import { hostedCreateNote, hostedPromoteNote, type NoteClientOptions } from './note-client.ts'
import {
  askNoteDuplicateQuestions,
  jevOnlyDuplicateCandidates,
  recordNoteDuplicateMerge,
  recordNoteDuplicateOutcomes,
} from './note-duplicate-question.ts'
import { deriveNoteFileAnchors } from './note-file-anchors.ts'
import { noteGit } from './note-git.ts'
import {
  noteRowFromHosted,
  pushedAcknowledgement,
  pushedNote,
  sendHostedRepeatSighting,
} from './note-hosted-record.ts'
import { createOutsideProjectNote } from './note-outside.ts'
import { noteDestinationOptions } from './note-project-space.ts'
import {
  notePromotionBody,
  promotionTitleRefusal,
  requiredPromotionTitle,
} from './note-promotion-body.ts'
import { relinkHostedNote } from './note-relink-record.ts'
import type { NoteRow } from './note-row.ts'
import { getNote, listActionableNotes, listNotes, listProjectNotes } from './note-read.ts'
import { evaluateNoteStaleness, type StalenessAnchorObservation } from './note-staleness.ts'
import {
  applyHostedStaleness,
  applyLocalStaleness,
  type StalenessChange,
  type StalenessResult,
} from './note-staleness-store.ts'
import { dispatchNoteCurator, readRunsById } from './orch.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import { projects, type RegisteredProject } from './projects.ts'
import { HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE, HOSTED_NOTE_TABLE } from './push-contract.ts'
import {
  attachLocalTaskEvidenceInTransaction,
  createLocalTaskInTransaction,
  duplicateCandidates,
  recordNoteRelinkCommentsInTransaction,
} from './task.ts'
import { applyHostedTask, applyHostedTaskComment } from './task-cache.ts'
import type { TaskRow } from './task-row.ts'
import { taskCreationDestination } from './tracker-new.ts'

export type NoteAnchor = NoteAnchorWire
export { getNote, listActionableNotes, listNotes, listProjectNotes }

export function parseNoteAnchor(value: unknown): NoteAnchor {
  return parseNoteAnchorWire(value)
}

export function confineExplicitNoteAnchor(
  anchor: NoteAnchor,
  facts: { cwdProject: string | null; projectPath: string; realpath?: (path: string) => string },
): NoteAnchor {
  if (!facts.cwdProject) throw new Error('anchor.project: hub cwd has no registered project')
  if (anchor.project !== facts.cwdProject) {
    throw new Error(`anchor.project: expected '${facts.cwdProject}'`)
  }
  const realpath = facts.realpath ?? realpathSync
  const root = realpath(facts.projectPath)
  for (const [index, file] of anchor.files.entries()) {
    let path: string
    try {
      path = realpath(file.path)
    } catch {
      throw new Error(`anchor.files[${index}].path: cannot resolve inside the registered checkout`)
    }
    const fromRoot = relative(root, path)
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error(`anchor.files[${index}].path: must resolve inside the registered checkout`)
    }
  }
  return anchor
}

export function parseExplicitNoteAnchor(value: unknown, cwd = process.cwd()): NoteAnchor {
  const anchor = parseNoteAnchor(value)
  const cwdProject = projectOf(cwd)
  const project = projects().find((candidate) => candidate.name === cwdProject)
  if (!project) throw new Error('anchor.project: hub cwd has no registered project')
  return confineExplicitNoteAnchor(anchor, { cwdProject, projectPath: project.path })
}

type NoteCandidate = Pick<NoteRow, 'record_id' | 'number' | 'label' | 'project' | 'text'> & {
  score: number
  probability?: number
}
export type NoteAcknowledgement = { note: NoteRow; alreadyAcknowledged: boolean }
export type CreateNoteInput = {
  text: string
  cwd?: string
  area?: string
  sameAs?: string
  forceNew?: boolean
  anchor?: NoteAnchor
  project?: string
}

function decode(row: Omit<NoteRow, 'anchors' | 'label'> & { anchors: string }): NoteRow {
  return {
    ...row,
    label: formatNoteLabel(row.project, row.number),
    anchors: JSON.parse(row.anchors) as NoteAnchor[],
  }
}

function registeredProject(name: string): RegisteredProject {
  const project = projects().find((candidate) => candidate.name === name)
  if (!project)
    throw new Error(`project '${name}' is not registered; run \`${PLATFORM_SLUG} project list\``)
  return project
}

const isRegisteredNoteProject = (name: string) =>
  projects().some((candidate) => candidate.name === name)

function writeMode(
  projectName: string,
  hosted?: NoteClientOptions,
): 'hosted-configured' | 'local-authoritative' {
  const project = projects().find((candidate) => candidate.name === projectName)
  if (!project) throw new Error(`unknown project '${projectName}'`)
  const decision = projectWriteDecisionFor(
    project,
    readInstallBinding(),
    hosted?.baseUrl ?? resolveHostedUrl(),
  )
  if (decision.mode === 'refused') throw new Error(decision.reason)
  return decision.mode
}

function noteRow(
  conn: Database,
  recordId: string,
): Omit<NoteRow, 'anchors' | 'label'> & { anchors: string } {
  const row = conn
    .query<Omit<NoteRow, 'anchors' | 'label'> & { anchors: string }, [string]>(
      'SELECT * FROM note WHERE record_id = ?',
    )
    .get(recordId)
  if (!row) throw new Error(`no note ${recordId}`)
  return row
}

function mintLocalNoteNumber(conn: Database, project: string): number {
  const number =
    conn
      .query<{ next: number }, [string]>('SELECT next FROM note_counter WHERE project=?')
      .get(project)?.next ?? 1
  conn
    .query(
      `INSERT INTO note_counter (record_id, project, project_record_id, next) VALUES (?, ?, ?, ?)
       ON CONFLICT(project) DO UPDATE SET next = MAX(note_counter.next, excluded.next),
       project_record_id=COALESCE(excluded.project_record_id,note_counter.project_record_id)`,
    )
    .run(newRecordId(), project, projectRecordIdFor(project), number + 1)
  return number
}

export function deriveNoteAnchor(text: string, cwd = process.cwd(), env = process.env): NoteAnchor {
  const project = projectOf(cwd)
  if (!project) throw new Error(`cannot file note: no registered project contains ${cwd}`)
  const projectPath = projects().find((candidate) => candidate.name === project)?.path ?? cwd
  const files = deriveNoteFileAnchors(text, projectPath)
  const runRecordId = env.BOTTEGA_RUN_ID
  return {
    id: newRecordId(),
    cwd,
    project,
    files,
    run_record_id: runRecordId && hasRecordIdShape(runRecordId) ? runRecordId.toLowerCase() : null,
    branch: noteGit(cwd, 'branch', '--show-current') || null,
    commit: noteGit(cwd, 'rev-parse', 'HEAD') || null,
    session_id: env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID ?? null,
  }
}

export function noteSessionId(env = process.env): string | null {
  return env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID ?? null
}

function identifiedAnchor(anchor: NoteAnchor): NoteAnchor {
  return anchor.id ? anchor : { ...anchor, id: newRecordId() }
}

export function resolveNoteReference(value: string, sessionProject: string | null): string {
  return resolveNoteIdentity(db(), value, sessionProject, isRegisteredNoteProject)
}

export async function acknowledgeNote(
  recordId: string,
  session: string,
  options: { hosted?: NoteClientOptions } = {},
): Promise<NoteAcknowledgement> {
  const sessionId = session.trim()
  if (!sessionId) throw new Error('cannot keep note: no session identity')
  const note = await getNote(recordId, options.hosted)
  const mode = writeMode(note.project, options.hosted)
  const at = nowIso()
  const existing = db()
    .query<{ sightings: number }, [string, string]>(
      'SELECT sightings FROM note_acknowledgement WHERE note_record_id=? AND session_id=?',
    )
    .get(note.record_id, sessionId)
  if (existing?.sightings === note.sightings) return { note, alreadyAcknowledged: true }
  if (mode === 'hosted-configured') {
    const acknowledgement = pushedAcknowledgement({
      id: newRecordId(),
      note,
      sessionId,
      at,
    })
    const destination = await noteDestinationOptions(note.project, options.hosted)
    await sendHostedChanges(
      `note ${note.label}`,
      [
        [
          {
            table: HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
            id: acknowledgement.id,
            op: 'upsert',
            row: acknowledgement,
          },
        ],
      ],
      {
        ...destination,
        conflictRemedy: `${PLATFORM_SLUG} note list --project ${note.project}`,
      },
    )
    writeTransaction((conn) => {
      conn
        .query(
          `INSERT INTO note_acknowledgement (record_id,note_record_id,session_id,acknowledged_at,sightings)
           VALUES (?,?,?,?,?) ON CONFLICT(note_record_id,session_id) DO UPDATE SET
           record_id=excluded.record_id,acknowledged_at=excluded.acknowledged_at,
           sightings=excluded.sightings`,
        )
        .run(
          acknowledgement.id,
          note.record_id,
          sessionId,
          acknowledgement.acknowledged_at,
          acknowledgement.sightings,
        )
    })
    return { note, alreadyAcknowledged: false }
  }
  writeTransaction((conn) => {
    const row = decode(noteRow(conn, note.record_id))
    conn
      .query(
        `INSERT INTO note_acknowledgement (record_id,note_record_id,session_id,acknowledged_at,sightings)
         VALUES (?,?,?,?,?) ON CONFLICT(note_record_id,session_id) DO UPDATE SET
         acknowledged_at=excluded.acknowledged_at,sightings=excluded.sightings`,
      )
      .run(newRecordId(), row.record_id, sessionId, at, row.sightings)
  })
  return { note: await getNote(note.record_id, options.hosted), alreadyAcknowledged: false }
}

function noteCandidates(notes: NoteRow[], text: string): NoteCandidate[] {
  const byId = new Map(notes.map((note) => [note.record_id, note]))
  return duplicateCandidates(
    notes.map(
      (note): TaskRow => ({
        record_id: note.record_id,
        external_id: null,
        key: note.record_id,
        project: note.project,
        title: note.text,
        status: null,
        status_category: null,
        parent_key: null,
        parent_record_id: null,
        body: null,
        assignee: null,
        opened_at: note.created_at,
        closed_at: null,
        updated_at: note.last_seen_at,
        source: 'local',
        first_seen: note.created_at,
        last_seen: note.last_seen_at,
        next_document_number: 1,
        retired_reason: null,
      }),
    ),
    text,
  ).map((candidate) => {
    const note = byId.get(candidate.key)!
    return {
      record_id: note.record_id,
      number: note.number,
      label: note.label,
      project: note.project,
      text: note.text,
      score: candidate.score,
    }
  })
}

export async function mergeNote(
  targetRecordId: string,
  sourceRecordId: string,
  options: { hosted?: NoteClientOptions } = {},
): Promise<NoteRow> {
  if (targetRecordId === sourceRecordId) throw new Error('a note cannot be merged with itself')
  const target = await getNote(targetRecordId, options.hosted)
  const sourceNote = await getNote(sourceRecordId, options.hosted)
  if (target.project !== sourceNote.project)
    throw new Error('notes from different projects cannot be merged')
  const mode = writeMode(target.project, options.hosted)
  if (mode === 'local-authoritative') {
    writeTransaction((conn) => {
      const current = decode(noteRow(conn, targetRecordId))
      const source = decode(noteRow(conn, sourceRecordId))
      if (current.project !== source.project)
        throw new Error('notes from different projects cannot be merged')
      const lastSeen =
        current.last_seen_at > source.last_seen_at ? current.last_seen_at : source.last_seen_at
      const merged = mergeNoteAnchors(current.anchors, source.anchors.map(identifiedAnchor))
      conn
        .query(`UPDATE note SET anchors=?, sightings=?, last_seen_at=? WHERE record_id=?`)
        .run(JSON.stringify(merged.anchors), merged.sightings, lastSeen, current.record_id)
      conn.query('DELETE FROM note WHERE record_id=?').run(source.record_id)
    })
    const merged = await getNote(targetRecordId, options.hosted)
    await recordNoteDuplicateMerge(targetRecordId, sourceNote.text)
    return merged
  }
  const at = nowIso()
  const union = mergeNoteAnchors(target.anchors, sourceNote.anchors.map(identifiedAnchor))
  const merged: NoteRow = {
    ...target,
    anchors: union.anchors,
    sightings: union.sightings,
    last_seen_at:
      target.last_seen_at > sourceNote.last_seen_at ? target.last_seen_at : sourceNote.last_seen_at,
  }
  const destination = await noteDestinationOptions(target.project, options.hosted)
  try {
    await sendHostedChanges(
      `note ${target.label}`,
      [
        [
          {
            table: HOSTED_NOTE_TABLE,
            id: target.record_id,
            op: 'upsert',
            row: pushedNote(merged, at),
            fields: ['anchors', 'last_seen_at'],
            expected_revision: target.revision,
          },
        ],
        [
          {
            table: HOSTED_NOTE_TABLE,
            id: sourceNote.record_id,
            op: 'delete',
            expected_revision: sourceNote.revision,
          },
        ],
      ],
      {
        ...destination,
        conflictRemedy: `${PLATFORM_SLUG} note list --project ${target.project}`,
      },
    )
  } catch (cause) {
    if (cause instanceof HostedChangeStageError && cause.stageIndex === 1)
      throw new Error(
        `${cause.message}; the target holds the merged sightings but source ${sourceNote.label} still exists; rerun \`${PLATFORM_SLUG} note same ${target.label} ${sourceNote.label}\``,
      )
    throw cause
  }
  writeTransaction((conn) => {
    conn
      .query(`UPDATE note SET anchors=?,sightings=?,last_seen_at=? WHERE record_id=?`)
      .run(JSON.stringify(merged.anchors), merged.sightings, merged.last_seen_at, merged.record_id)
    conn.query('DELETE FROM note WHERE record_id=?').run(sourceNote.record_id)
  })
  await recordNoteDuplicateMerge(targetRecordId, sourceNote.text)
  return merged
}

function completedNoteCreation(
  note: NoteRow,
  candidates: NoteCandidate[],
  input: { text: string; sameAs?: string; forceNew?: boolean },
  project: string,
): CreateNoteResult {
  if (input.sameAs) recordNoteDuplicateOutcomes(input.text, project, 'same-as', input.sameAs)
  else if (input.forceNew) recordNoteDuplicateOutcomes(input.text, project, 'new')
  else recordNoteDuplicateOutcomes(input.text, project, 'filed')
  return { note, candidates, outside: false }
}

export type CreateNoteResult = {
  note: NoteRow
  candidates: NoteCandidate[]
  outside: boolean
}

async function duplicateCandidatesForNewNote(
  text: string,
  project: string,
  sameAs: string | undefined,
  hosted?: NoteClientOptions,
): Promise<NoteCandidate[]> {
  if (sameAs) return []
  const notes = await listNotes({ project, actionable: true }, hosted)
  const lexicalCandidates = noteCandidates(notes, text)
  const asked = await askNoteDuplicateQuestions(notes, project, text)
  return [
    ...lexicalCandidates,
    ...jevOnlyDuplicateCandidates(lexicalCandidates, asked).map(({ probability, ...note }) => ({
      record_id: note.record_id,
      number: note.number,
      label: note.label,
      project: note.project,
      text: note.text,
      score: note.score,
      probability,
    })),
  ]
}

async function outsideNoteCreation(
  input: CreateNoteInput,
  text: string,
  anchor: NoteAnchor,
  project: string,
  hosted: NoteClientOptions | undefined,
) {
  if (input.sameAs) throw new Error('an outside note cannot be merged; file it as new')
  const note = await createOutsideProjectNote(
    { project, text, area: input.area?.trim() || null, anchor },
    hosted,
  )
  return { note, candidates: [], outside: true as const }
}

export async function createNote(
  input: CreateNoteInput,
  options: { hosted?: NoteClientOptions } = {},
): Promise<CreateNoteResult> {
  const text = input.text.trim()
  if (!text) throw new Error('note text is required')
  if (input.sameAs && input.forceNew) throw new Error('--same-as and --new are mutually exclusive')
  const anchor = identifiedAnchor(input.anchor ?? deriveNoteAnchor(text, input.cwd))
  const targetProject = input.project ?? anchor.project
  if (!isRegisteredNoteProject(targetProject))
    return outsideNoteCreation(input, text, anchor, targetProject, options.hosted)
  const registered = registeredProject(targetProject)
  const candidates = await duplicateCandidatesForNewNote(
    text,
    targetProject,
    input.sameAs,
    options.hosted,
  )
  const mode = writeMode(targetProject, options.hosted)
  if (input.sameAs) {
    const existing = await getNote(input.sameAs, options.hosted)
    if (existing.project !== targetProject)
      throw new Error('the matching note belongs to another project')
    if (mode === 'local-authoritative') {
      const at = nowIso()
      writeTransaction((conn) => {
        const row = decode(noteRow(conn, existing.record_id))
        if (row.project !== targetProject)
          throw new Error('the matching note belongs to another project')
        conn
          .query(
            `UPDATE note SET anchors=?, sightings=sightings+1, last_seen_at=?, stale_at=NULL, stale_reason=NULL WHERE record_id=?`,
          )
          .run(JSON.stringify([...row.anchors, anchor]), at, row.record_id)
      })
      return completedNoteCreation(
        await getNote(existing.record_id, options.hosted),
        candidates,
        input,
        targetProject,
      )
    }
    const at = nowIso()
    const updated = await sendHostedRepeatSighting(existing, anchor, at, options.hosted)
    writeTransaction((conn) => {
      conn
        .query(
          `UPDATE note SET anchors=?,sightings=?,last_seen_at=?,stale_at=NULL,stale_reason=NULL WHERE record_id=?`,
        )
        .run(JSON.stringify(updated.anchors), updated.sightings, at, updated.record_id)
    })
    return completedNoteCreation(updated, candidates, input, targetProject)
  }
  if (candidates.length && !input.forceNew)
    return { note: null as never, candidates, outside: false }
  if (mode === 'local-authoritative') {
    const at = nowIso()
    const recordId = writeTransaction((conn) => {
      const number = mintLocalNoteNumber(conn, targetProject)
      const recordId = newRecordId()
      conn
        .query(
          `INSERT INTO note (record_id,number,project,project_record_id,text,area,anchors,sightings,created_at,last_seen_at)
       VALUES (?,?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          recordId,
          number,
          targetProject,
          projectRecordIdFor(targetProject),
          text,
          input.area?.trim() || null,
          JSON.stringify([anchor]),
          at,
          at,
        )
      return recordId
    })
    return completedNoteCreation(
      await getNote(recordId, options.hosted),
      candidates,
      input,
      targetProject,
    )
  }
  const hostedOptions = await noteDestinationOptions(targetProject, options.hosted)
  const hosted = await hostedCreateNote(
    {
      project: targetProject,
      projectId: registered.record_id,
      text,
      area: input.area?.trim() || null,
      anchor: JSON.stringify(anchor),
    },
    hostedOptions,
  )
  applyHostedWriteLocally(
    `${formatNoteLabel(hosted.project, hosted.number)} was created in the hosted record; its local copy will arrive on the next record pull`,
    () => writeTransaction((conn) => applyHostedNote(conn, hosted)),
  )
  return completedNoteCreation(noteRowFromHosted(hosted), candidates, input, targetProject)
}

export async function promoteNote(
  recordId: string,
  options: {
    hosted?: NoteClientOptions
    existingTaskKey?: string
    title?: string
  } = {},
): Promise<NoteRow> {
  const note = await getNote(recordId, options.hosted)
  if (note.promoted_task)
    throw new Error(`note ${note.label} is already promoted to ${note.promoted_task}`)
  const creating = options.existingTaskKey === undefined
  const titleRefusal = promotionTitleRefusal(note.label)
  const title = creating ? requiredPromotionTitle(options.title, titleRefusal) : ''
  const project = projects().find((candidate) => candidate.name === note.project)!
  const destination = taskCreationDestination(project)
  if (destination === 'tracker' && !options.existingTaskKey)
    throw new Error(
      `project ${note.project} owns task creation in its tracker; create the task there, then link it with: ${PLATFORM_SLUG} note promote ${note.label} --task <KEY>`,
    )
  if (options.existingTaskKey) {
    const prefixes = project.settings.keyPrefixes ?? []
    const prefix = options.existingTaskKey.split('-', 1)[0]?.toUpperCase()
    if (!prefix || !prefixes.some((candidate) => candidate.toUpperCase() === prefix))
      throw new Error(
        `task key '${options.existingTaskKey}' has the wrong prefix for project ${note.project}; expected: ${prefixes.join(', ')}`,
      )
  }
  const mode = writeMode(note.project, options.hosted)
  if (mode === 'local-authoritative') {
    if (destination === 'tracker') {
      writeTransaction((conn) => {
        const row = decode(noteRow(conn, note.record_id))
        if (row.promoted_task)
          throw new Error(`note ${row.label} is already promoted to ${row.promoted_task}`)
        conn
          .query(
            'UPDATE note SET promoted_task=?, promoted_task_record_id=NULL, last_seen_at=? WHERE record_id=?',
          )
          .run(options.existingTaskKey!, nowIso(), row.record_id)
      })
      return getNote(note.record_id, options.hosted)
    }
    if (options.existingTaskKey) {
      writeTransaction((conn) => {
        const row = decode(noteRow(conn, note.record_id))
        if (row.promoted_task)
          throw new Error(`note ${row.label} is already promoted to ${row.promoted_task}`)
        const at = nowIso()
        const task = attachLocalTaskEvidenceInTransaction(
          conn,
          options.existingTaskKey!,
          row.project,
          notePromotionBody(row.text, row.sightings, row.anchors),
          at,
        )
        conn
          .query(
            'UPDATE note SET promoted_task=?, promoted_task_record_id=?, last_seen_at=? WHERE record_id=?',
          )
          .run(task.task_key, task.task_record_id, at, row.record_id)
      })
      return getNote(note.record_id, options.hosted)
    }
    writeTransaction((conn) => {
      const row = decode(noteRow(conn, note.record_id))
      if (row.promoted_task)
        throw new Error(`note ${row.label} is already promoted to ${row.promoted_task}`)
      const task = createLocalTaskInTransaction(
        conn,
        {
          project: row.project,
          title,
          body: notePromotionBody(row.text, row.sightings, row.anchors),
        },
        { skipDuplicateCheck: true },
      )
      conn
        .query(
          'UPDATE note SET promoted_task=?, promoted_task_record_id=?, last_seen_at=? WHERE record_id=?',
        )
        .run(task.key, task.record_id, nowIso(), row.record_id)
    })
    return getNote(note.record_id, options.hosted)
  }
  const hostedOptions = await noteDestinationOptions(note.project, options.hosted)
  const promoteInput = creating ? { title } : { task: options.existingTaskKey! }
  const hosted = await hostedPromoteNote(note.record_id, promoteInput, hostedOptions)
  const reference = hosted.task?.key ?? formatNoteLabel(hosted.note.project, hosted.note.number)
  applyHostedWriteLocally(
    `${reference} was updated in the hosted record; its local copy will arrive on the next record pull`,
    () =>
      writeTransaction((conn) => {
        if (hosted.task) applyHostedTask(conn, hosted.task)
        if (hosted.comment) applyHostedTaskComment(conn, hosted.comment)
        applyHostedNote(conn, hosted.note)
      }),
  )
  return noteRowFromHosted(hosted.note)
}

export function promotionTaskInput(note: NoteRow, title: string) {
  return { title, body: notePromotionBody(note.text, note.sightings, note.anchors) }
}

export async function dropNote(
  recordId: string,
  reason: string,
  options: { hosted?: NoteClientOptions } = {},
): Promise<NoteRow> {
  if (!reason.trim()) throw new Error('--reason is required')
  const current = await getNote(recordId, options.hosted)
  const mode = writeMode(current.project, options.hosted)
  if (mode === 'local-authoritative') {
    const at = nowIso()
    writeTransaction((conn) => {
      noteRow(conn, recordId)
      conn
        .query(`UPDATE note SET stale_at=?, stale_reason=?, last_seen_at=? WHERE record_id=?`)
        .run(at, `dropped: ${reason.trim()}`, at, recordId)
    })
    return getNote(recordId, options.hosted)
  }
  const at = nowIso()
  const updated: NoteRow = {
    ...current,
    stale_at: at,
    stale_reason: `dropped: ${reason.trim()}`,
    last_seen_at: at,
  }
  const destination = await noteDestinationOptions(current.project, options.hosted)
  await sendHostedChanges(
    `note ${current.label}`,
    [
      [
        {
          table: HOSTED_NOTE_TABLE,
          id: current.record_id,
          op: 'upsert',
          row: pushedNote(updated, at),
          fields: ['stale_at', 'stale_reason', 'last_seen_at'],
          expected_revision: current.revision,
        },
      ],
    ],
    {
      ...destination,
      conflictRemedy: `${PLATFORM_SLUG} note list --project ${current.project}`,
    },
  )
  writeTransaction((conn) => {
    noteRow(conn, recordId)
    conn
      .query(`UPDATE note SET stale_at=?,stale_reason=?,last_seen_at=? WHERE record_id=?`)
      .run(at, updated.stale_reason, at, recordId)
  })
  return updated
}

export async function relinkNote(
  recordId: string,
  targetTask: string,
  reason: string,
  options: { hosted?: NoteClientOptions } = {},
): Promise<NoteRow> {
  if (!reason.trim()) throw new Error('--reason is required')
  const current = await getNote(recordId, options.hosted)
  if (!current.promoted_task)
    throw new Error(
      `note ${current.label} has no attachment; attach it with: ${PLATFORM_SLUG} note promote ${current.label} --task <KEY>`,
    )
  const target = targetTask.trim().toUpperCase()
  if (!target) throw new Error('--task is required')
  if (target === current.promoted_task.toUpperCase())
    throw new Error(
      `note ${current.label} is already attached to ${current.promoted_task}; choose a different task with --task <KEY>`,
    )
  const project = registeredProject(current.project)
  if (taskCreationDestination(project) === 'tracker')
    throw new Error(
      `note ${current.label} cannot be relinked in project ${current.project}: its tasks are tracker-owned, and relink records its trail as task comments in the hub that tracker-owned tasks cannot carry; use note relink only for a hub-owned project`,
    )
  const mode = writeMode(current.project, options.hosted)
  const at = nowIso()
  if (mode === 'hosted-configured')
    return relinkHostedNote(current, target, reason.trim(), at, options.hosted)
  writeTransaction((conn) => {
    const row = decode(noteRow(conn, recordId))
    if (!row.promoted_task)
      throw new Error(
        `note ${row.label} has no attachment; attach it with: ${PLATFORM_SLUG} note promote ${row.label} --task <KEY>`,
      )
    if (target === row.promoted_task.toUpperCase())
      throw new Error(
        `note ${row.label} is already attached to ${row.promoted_task}; choose a different task with --task <KEY>`,
      )
    const history = recordNoteRelinkCommentsInTransaction(conn, {
      project: row.project,
      noteLabel: row.label,
      previousTask: row.promoted_task,
      targetTask: target,
      reason: reason.trim(),
      at,
      queue: false,
    })
    conn
      .query(
        `UPDATE note SET promoted_task=?,promoted_task_record_id=?,last_seen_at=? WHERE record_id=?`,
      )
      .run(target, history.targetTaskRecordId, at, row.record_id)
  })
  return getNote(recordId, options.hosted)
}

export type StaleResult = StalenessResult

type StaleDeps = {
  runExists(ids: string[]): Promise<Set<string>>
  git(cwd: string, ...args: string[]): string | null
  readFile(path: string): string | null
  now(): Date
  hosted: NoteClientOptions
}

async function defaultRunExists(ids: string[]): Promise<Set<string>> {
  const rows = await readRunsById(ids)
  return new Set(rows.flatMap((row) => ('unknown' in row ? [] : [row.record_id])))
}

const stalenessFileReader = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function observeStalenessAnchor(
  anchor: NoteAnchor,
  noteProject: string,
  registered: Array<{ name: string; path: string; trunk: string }>,
  existingRuns: Set<string>,
  runGit: StaleDeps['git'],
  readFile: StaleDeps['readFile'],
): StalenessAnchorObservation {
  const projectName = anchor.project || noteProject
  const project = registered.find((candidate) => candidate.name === projectName)
  const files = anchor.files.map((file) => {
    const path = isAbsolute(file.path) ? file.path : resolve(anchor.cwd, file.path)
    const contents = readFile(path)
    const anchored = file.content.trim()
    return {
      path: file.path,
      line: file.line,
      exists: contents !== null,
      containsAnchoredContent:
        contents !== null &&
        (!anchored || contents.split(/\r?\n/).some((line) => line.trim() === anchored)),
    }
  })
  let branch: StalenessAnchorObservation['branch'] = null
  if (project && anchor.branch && anchor.branch !== project.trunk) {
    const exists =
      runGit(project.path, 'show-ref', '--verify', `refs/heads/${anchor.branch}`) !== null
    branch = {
      name: anchor.branch,
      trunk: project.trunk,
      exists,
      landed:
        exists &&
        runGit(project.path, 'merge-base', '--is-ancestor', anchor.branch, project.trunk) !== null,
    }
  }
  return {
    sessionId: anchor.session_id,
    projectFound: project !== undefined,
    files,
    run: anchor.run_record_id
      ? {
          label: anchor.run_record_id,
          exists: existingRuns.has(anchor.run_record_id),
        }
      : null,
    branch,
  }
}

export async function staleNotes(deps: Partial<StaleDeps> = {}): Promise<StaleResult> {
  const runGit = deps.git ?? noteGit
  const readFile = deps.readFile ?? stalenessFileReader
  const clock = deps.now?.() ?? new Date()
  const notes = await listNotes({}, deps.hosted)
  const runIds = [
    ...new Set(
      notes.flatMap((note) =>
        note.anchors.flatMap((anchor) => (anchor.run_record_id ? [anchor.run_record_id] : [])),
      ),
    ),
  ]
  const existingRuns = await (deps.runExists ?? defaultRunExists)(runIds)
  const acknowledgements = db()
    .query<{ note_record_id: string; session_id: string }, []>(
      'SELECT note_record_id,session_id FROM note_acknowledgement',
    )
    .all()
  const acknowledgementSessions = new Map<string, string[]>()
  for (const acknowledgement of acknowledgements) {
    const sessions = acknowledgementSessions.get(acknowledgement.note_record_id) ?? []
    sessions.push(acknowledgement.session_id)
    acknowledgementSessions.set(acknowledgement.note_record_id, sessions)
  }
  const registered = projects().map((project) => ({
    name: project.name,
    path: project.path,
    trunk: typeof project.settings.trunk === 'string' ? project.settings.trunk : 'main',
  }))
  const evaluations = notes.map((note) => {
    const anchors = note.anchors.map((anchor) =>
      observeStalenessAnchor(anchor, note.project, registered, existingRuns, runGit, readFile),
    )
    const outcome = evaluateNoteStaleness({
      note: {
        anchors,
        promotedTask: note.promoted_task,
        staleAt: note.stale_at,
        staleReason: note.stale_reason,
      },
      acknowledgementSessions: acknowledgementSessions.get(note.record_id) ?? [],
    })
    return { note, outcome }
  })
  const changes = evaluations.flatMap(({ note, outcome }): StalenessChange[] =>
    outcome.action === 'unchanged'
      ? []
      : [
          {
            recordId: note.record_id,
            label: note.label,
            project: note.project,
            action: outcome.action,
            reason: outcome.reason,
          },
        ],
  )
  const at = clock.toISOString()
  const cutoff = new Date(clock.getTime() - 30 * 86_400_000).toISOString()
  const deletedRows = evaluations.flatMap(({ note, outcome }) =>
    note.sightings === 1 &&
    note.last_seen_at <= cutoff &&
    note.promoted_task === null &&
    outcome.triaged &&
    (outcome.action === 'mark' || (note.stale_at !== null && outcome.action !== 'restore'))
      ? [{ record_id: note.record_id, project: note.project }]
      : [],
  )
  const deletedIds = deletedRows.map((row) => row.record_id)
  const url = deps.hosted?.baseUrl ?? resolveHostedUrl()
  if (hostedWriteMode(url) !== 'hosted-configured' && readInstallBinding().bound) {
    throw new Error(
      `this install belongs to a hosted space; local writes are refused while hosting is unavailable. ${hostedUnavailableRemedy(url)}`,
    )
  }
  if (hostedWriteMode(url) !== 'hosted-configured') {
    return applyLocalStaleness(changes, deletedIds, at, cutoff)
  }
  return applyHostedStaleness(changes, deletedRows, at, cutoff, projects(), deps.hosted)
}

export function curatorEnabled(): boolean {
  const row = db()
    .query<{ value: string }, []>("SELECT value FROM setting WHERE key='note.curator.enabled'")
    .get()
  return row?.value === 'true'
}

export function setCuratorEnabled(enabled: boolean): boolean {
  writeTransaction((conn) =>
    conn
      .query(
        "INSERT INTO setting(key,value) VALUES ('note.curator.enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(enabled)),
  )
  return enabled
}

export async function curateNotes(
  scheduled = false,
): Promise<{ project: string; result: string }[]> {
  if (scheduled && !curatorEnabled()) return []
  const results: { project: string; result: string }[] = []
  for (const project of projects()) {
    const notes = await listActionableNotes({ project: project.name })
    if (!notes.length) continue
    const prompt = noteCuratorPrompt(notes)
    results.push({ project: project.name, result: await dispatchNoteCurator(project.path, prompt) })
  }
  return results
}

export function noteCuratorPrompt(notes: Pick<NoteRow, 'label' | 'text'>[]): string {
  return [
    'Re-read every open note below against this checkout. Return proposals only; make no changes.',
    'For each note return: still-holds, genuine-duplicate-of-project#number, earned-promotion, and area, with reasons.',
    `A human will act through ${PLATFORM_SLUG} note same, drop, or promote.`,
    '',
    ...notes.map((note) => `${note.label}: ${note.text}`),
  ].join('\n')
}
