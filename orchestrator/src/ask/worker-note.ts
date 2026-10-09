import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { nowIso } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { type FiledNoteAnchor, fileNote } from '../mcp/hub-notes.ts'

export const WORKER_NOTE_MAX_LENGTH = 1_000
export const WORKER_NOTE_MAX_FILE_BYTES = 1_000_000

export type WorkerNoteInput = { text: string; file?: string; sameAs?: string }
export type WorkerNoteFiledResult = {
  noteRecordId: string
  noteLabel: string
  candidateNotes: { recordId: string; label: string }[]
  anchorDropped?: string
}

export type WorkerNoteRun = {
  id: number
  project: string
  projectPath: string
  tree: string
  branch: string | null
  sessionId: string | null
  headCommit: string | null
}

export type WorkerNoteFileFact = { path: string; line: number; content: string }
export type WorkerNoteAnchorDecision = {
  file?: WorkerNoteFileFact
  dropped?: string
}

/** Keep a durable main-checkout anchor only when it names the line the worker saw. */
export function stableWorkerNoteFileAnchor(
  treeFile: WorkerNoteFileFact,
  mainContent: string | null,
): WorkerNoteAnchorDecision {
  if (mainContent === treeFile.content) return { file: treeFile }
  return {
    dropped: `File anchor ${treeFile.path}:${treeFile.line} was dropped because the line is new or changed on the branch.`,
  }
}

export function validateWorkerNoteInput(input: WorkerNoteInput): WorkerNoteInput {
  const text = input.text.trim()
  if (!text) throw new Error('Note text is required and cannot be empty.')
  if (/[\r\n]/.test(input.text)) throw new Error('Note text must be a single line.')
  if (text.length > WORKER_NOTE_MAX_LENGTH) {
    throw new Error(
      `Note text must be at most ${WORKER_NOTE_MAX_LENGTH.toLocaleString('en-US')} Unicode code units.`,
    )
  }
  const sameAs = input.sameAs?.trim()
  if (input.sameAs !== undefined && !sameAs) throw new Error('same_as must be a note reference.')
  if (input.file === undefined) return { text, ...(sameAs ? { sameAs } : {}) }
  const file = input.file.trim()
  if (file.length > WORKER_NOTE_MAX_LENGTH) {
    throw new Error(
      `File anchor must be at most ${WORKER_NOTE_MAX_LENGTH.toLocaleString('en-US')} Unicode code units.`,
    )
  }
  const match = /^(.*):([1-9]\d*)$/.exec(file)
  if (!match?.[1]) throw new Error('File anchor must use the relative path:line form.')
  if (isAbsolute(match[1])) throw new Error('File anchor path must be relative to the run tree.')
  const normalized = relative('.', resolve('.', match[1]))
  if (
    !normalized ||
    normalized === '..' ||
    normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error('File anchor path must stay inside the run tree.')
  }
  return { text, file: `${match[1]}:${match[2]}`, ...(sameAs ? { sameAs } : {}) }
}

export function deriveWorkerNoteAnchor(
  run: WorkerNoteRun,
  file?: WorkerNoteFileFact,
): FiledNoteAnchor {
  return {
    cwd: run.projectPath,
    project: run.project,
    files: file ? [{ ...file, path: resolve(run.projectPath, file.path) }] : [],
    run_id: run.id,
    branch: null,
    commit: run.headCommit,
    session_id: run.sessionId,
  }
}

export type WorkerNoteFileStat = {
  symbolicLink: boolean
  regularFile: boolean
  links: number
  size: number
}

export function workerNoteFileRefusal(fact: WorkerNoteFileStat): string | null {
  if (fact.symbolicLink) return 'File anchor must not name a symbolic link.'
  if (!fact.regularFile) return 'File anchor must name a regular file.'
  if (fact.links > 1) return 'File anchor must not name a file with multiple hard links.'
  if (fact.size > WORKER_NOTE_MAX_FILE_BYTES) {
    return `File anchor must name a file no larger than ${WORKER_NOTE_MAX_FILE_BYTES.toLocaleString('en-US')} bytes.`
  }
  return null
}

function boundedLine(fd: number, requested: number): string {
  const bytes: number[] = []
  const byte = Buffer.allocUnsafe(1)
  let line = 1
  let total = 0
  while (readSync(fd, byte, 0, 1, null) === 1) {
    total += 1
    if (total > WORKER_NOTE_MAX_FILE_BYTES) {
      throw new Error(
        `File anchor must name a file no larger than ${WORKER_NOTE_MAX_FILE_BYTES.toLocaleString('en-US')} bytes.`,
      )
    }
    if (byte[0] === 10) {
      if (line === requested) return Buffer.from(bytes).toString('utf8').replace(/\r$/, '')
      line += 1
      bytes.length = 0
      continue
    }
    if (line === requested) {
      bytes.push(byte[0]!)
      if (bytes.length > WORKER_NOTE_MAX_LENGTH * 4) {
        throw new Error(`File anchor line ${requested} exceeds the note length bound.`)
      }
    }
  }
  if (line !== requested) throw new Error(`File anchor line ${requested} does not exist.`)
  return Buffer.from(bytes).toString('utf8').replace(/\r$/, '')
}

export function fileFact(tree: string, value: string): WorkerNoteFileFact {
  const match = /^(.*):([1-9]\d*)$/.exec(value)!
  const root = realpathSync(tree)
  const unresolved = resolve(root, match[1]!)
  const before = lstatSync(unresolved)
  const refusal = workerNoteFileRefusal({
    symbolicLink: before.isSymbolicLink(),
    regularFile: before.isFile(),
    links: before.nlink,
    size: before.size,
  })
  if (refusal) throw new Error(refusal)
  const path = realpathSync(unresolved)
  const fromRoot = relative(root, path)
  if (
    !fromRoot ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error('File anchor path must resolve to a file inside the run tree.')
  }
  const line = Number(match[2])
  const fd = openSync(path, 'r')
  let content: string
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('File anchor changed while it was being opened.')
    }
    const openedRefusal = workerNoteFileRefusal({
      symbolicLink: false,
      regularFile: opened.isFile(),
      links: opened.nlink,
      size: opened.size,
    })
    if (openedRefusal) throw new Error(openedRefusal)
    content = boundedLine(fd, line)
  } finally {
    closeSync(fd)
  }
  if (content.length > WORKER_NOTE_MAX_LENGTH) {
    throw new Error(`File anchor line ${line} exceeds the note length bound.`)
  }
  return { path: fromRoot, line, content }
}

export async function fileWorkerNote(
  run: WorkerNoteRun,
  input: WorkerNoteInput,
): Promise<WorkerNoteFiledResult> {
  let decision: WorkerNoteAnchorDecision = {}
  if (input.file) {
    const treeFile = fileFact(run.tree, input.file)
    let mainContent: string | null = null
    try {
      mainContent = fileFact(run.projectPath, input.file).content
    } catch {
      // An absent or unsuitable main-checkout line makes the branch anchor unstable.
    }
    decision = stableWorkerNoteFileAnchor(treeFile, mainContent)
  }
  const anchor = deriveWorkerNoteAnchor(run, decision.file)
  const filed = await fileNote(
    input.sameAs ? { text: input.text, same_as: input.sameAs } : { text: input.text, new: true },
    { cwd: run.tree, anchor },
  )
  if (!filed.noteRecordId || !filed.noteLabel)
    throw new Error('The note service completed without returning a filed note identity.')
  appendRunEvent(run.id, {
    ts: nowIso(),
    type: 'note',
    noteRecordId: filed.noteRecordId,
    noteLabel: filed.noteLabel,
    candidates: filed.candidateNotes,
  })
  if (decision.dropped) {
    appendRunEvent(run.id, {
      ts: nowIso(),
      type: 'text',
      text: decision.dropped,
    })
  }
  return {
    noteRecordId: filed.noteRecordId,
    noteLabel: filed.noteLabel,
    candidateNotes: filed.candidateNotes,
    ...(decision.dropped ? { anchorDropped: decision.dropped } : {}),
  }
}
