import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { projectOf } from './attribute.ts'
import { requireDatabase } from './db.ts'
import {
  acknowledgeNote,
  createNote,
  curateNotes,
  curatorEnabled,
  dropNote,
  listActionableNotes,
  listNotes,
  mergeNote,
  noteSessionId,
  parseExplicitNoteAnchor,
  resolveNoteReference,
  setCuratorEnabled,
  staleNotes,
} from './note.ts'
import { promoteNoteCommand } from './note-promote-cli.ts'
import { pushNotes } from './note-push.ts'
import { projects } from './projects.ts'
import { showTask } from './task.ts'
import { taskCreationDestination } from './tracker-new.ts'

type NoteOptions = {
  actionable?: boolean
  anchorJson?: string
  area?: string
  disable?: boolean
  dryRun?: boolean
  enable?: boolean
  json?: boolean
  kept?: boolean
  new?: boolean
  project?: string
  reason?: string
  sameAs?: string
  scheduled?: boolean
  session?: string[]
  stale?: boolean
  task?: string
}

const repeat = (value: string, previous: string[] = []) => [...previous, value]
const open = () => requireDatabase()
const reference = (value: string, project?: string) =>
  resolveNoteReference(value, project ?? projectOf(process.cwd()))

function explicitNoteAnchor(value: string | undefined): Parameters<typeof createNote>[0]['anchor'] {
  return value ? parseExplicitNoteAnchor(JSON.parse(value)) : undefined
}

function listNoteCommand(options: NoteOptions): void {
  if (options.actionable && options.kept)
    throw new Error('--actionable and --kept are mutually exclusive')
  const sessions = [...(options.session ?? [])]
  if (options.kept && !sessions.length && noteSessionId()) sessions.push(noteSessionId()!)
  if (options.kept && !sessions.length)
    throw new Error(
      `${PLATFORM_SLUG} note list --kept requires --session ID or a session environment`,
    )
  const session = sessions.length ? sessions : undefined
  const rows = options.actionable
    ? listActionableNotes({ project: options.project, session })
    : listNotes({
        project: options.project,
        stale: Boolean(options.stale),
        session,
        kept: Boolean(options.kept),
      })
  if (options.json) console.log(JSON.stringify(rows))
  else if (!rows.length) console.log('no notes')
  else for (const row of rows) console.log(noteListLine(row))
}

async function keepNoteCommand(ids: string[], project?: string): Promise<void> {
  const session = noteSessionId()
  if (!session) throw new Error(`${PLATFORM_SLUG} note keep requires a session environment`)
  for (const id of ids) {
    const result = await acknowledgeNote(reference(id, project), session)
    console.log(noteKeepLine(result.note, result.alreadyAcknowledged))
  }
}

async function staleNoteCommand(): Promise<void> {
  const result = await staleNotes()
  for (const row of result.reasons) console.log(noteStaleLine(row))
  console.log(`${result.marked} marked stale; ${result.deleted} deleted`)
}

async function curateNoteCommand(scheduled: boolean): Promise<void> {
  const results = await curateNotes(scheduled)
  if (scheduled && !curatorEnabled()) {
    console.log('note curator is disabled')
    return
  }
  for (const result of results) console.log(`${result.project}: ${result.result}`)
}

function curatorNoteCommand(options: NoteOptions): void {
  if (Boolean(options.enable) === Boolean(options.disable)) {
    console.log(`note curator is ${curatorEnabled() ? 'enabled' : 'disabled'}`)
    return
  }
  console.log(`note curator ${setCuratorEnabled(Boolean(options.enable)) ? 'enabled' : 'disabled'}`)
}

async function newNoteCommand(text: string, options: NoteOptions): Promise<void> {
  const same = options.sameAs
  let result = await createNote({
    text,
    area: options.area,
    sameAs: same ? reference(same, options.project) : undefined,
    forceNew: Boolean(options.new),
    anchor: explicitNoteAnchor(options.anchorJson),
    project: options.project,
  })
  if (!result.note) result = await resolveDuplicateNote(text, options, result)
  if (!result.note) return
  if (options.json) console.log(JSON.stringify(noteFiledJson(result.note, result.candidates)))
  else {
    for (const candidate of result.candidates) console.log(`near ${noteCandidateLine(candidate)}`)
    for (const line of noteFiledOutput(result.note)) console.log(line)
  }
}

async function resolveDuplicateNote(
  text: string,
  options: NoteOptions,
  result: Awaited<ReturnType<typeof createNote>>,
): Promise<Awaited<ReturnType<typeof createNote>>> {
  if (options.json) {
    console.log(JSON.stringify(noteFiledJson(null, result.candidates)))
    return result
  }
  const lines = result.candidates.map(noteCandidateLine)
  if (!process.stdin.isTTY)
    throw new Error(
      `possible duplicate notes:\n${lines.join('\n')}\nPass --same-as <LABEL|UUID|NUMBER> or --new.`,
    )
  console.log(`possible duplicate notes:\n${lines.join('\n')}`)
  const answer = prompt(NOTE_DUPLICATE_PROMPT)?.trim() ?? ''
  const filed =
    answer && answer !== 'new'
      ? await createNote({
          text,
          area: options.area,
          sameAs: reference(answer, options.project),
          project: options.project,
        })
      : answer === 'new'
        ? await createNote({
            text,
            area: options.area,
            forceNew: true,
            project: options.project,
          })
        : result
  if (!filed.note) throw new Error('note not filed')
  return filed
}

function registerNoteReferenceCommands(note: Command): void {
  note
    .command('same <target> <source>')
    .description('merge another sighting into an existing note')
    .option('--project <name>', 'resolve both notes in this project')
    .action(async (target, source, options: NoteOptions) => {
      open()
      const row = await mergeNote(
        reference(target, options.project),
        reference(source, options.project),
      )
      console.log(noteSameLine(row))
    })
  note
    .command('keep <references...>')
    .description('acknowledge notes for the current session')
    .option('--project <name>', 'resolve the notes in this project')
    .action(async (references, options: NoteOptions) => {
      open()
      await keepNoteCommand(references, options.project)
    })
  note
    .command('promote <reference>')
    .description('promote a note to current task work')
    .option('--task <key>', 'link the note to this existing task')
    .option('--project <name>', 'resolve the note in this project')
    .action(async (noteReference, options: NoteOptions) => {
      open()
      const row = await promoteNoteCommand(
        reference(noteReference, options.project),
        options.task,
        options.task !== undefined,
      )
      const project = projects().find((candidate) => candidate.name === row.project)
      const linkedDone =
        options.task !== undefined &&
        project !== undefined &&
        taskCreationDestination(project) !== 'tracker' &&
        showTask(row.promoted_task!, { project: row.project }).task.status_category === 'done'
      console.log(linkedDone ? `${row.promoted_task} (done)` : `${row.promoted_task}`)
    })
  note
    .command('drop <reference>')
    .description('drop a note with a recorded reason')
    .option('--reason <reason>', 'record why the note is dropped')
    .option('--project <name>', 'resolve the note in this project')
    .action(async (noteReference, options: NoteOptions) => {
      open()
      if (!options.reason)
        throw new Error(`${PLATFORM_SLUG} note drop <LABEL|UUID|NUMBER> --reason "..."`)
      console.log(
        noteDropLine(await dropNote(reference(noteReference, options.project), options.reason)),
      )
    })
}

function registerNoteMaintenanceCommands(note: Command): void {
  note
    .command('stale')
    .description('mark vanished anchors and reap eligible notes')
    .action(async () => {
      open()
      await staleNoteCommand()
    })
  note
    .command('curate')
    .description('ask the curator to propose dispositions for open notes')
    .option('--scheduled', 'honor the curator enablement setting')
    .action(async (options: NoteOptions) => {
      open()
      await curateNoteCommand(Boolean(options.scheduled))
    })
  note
    .command('curator')
    .description('show or change scheduled note curation')
    .option('--enable', 'enable scheduled note curation')
    .option('--disable', 'disable scheduled note curation')
    .action((options: NoteOptions) => {
      open()
      curatorNoteCommand(options)
    })
  note
    .command('push')
    .description('migrate and verify the local note cache')
    .option('--dry-run', 'report local counts without writing hosted notes')
    .action(async (options: NoteOptions) => {
      open()
      const result = await pushNotes({ dryRun: Boolean(options.dryRun) })
      console.log(JSON.stringify(result, null, 2))
      if (result.match === false) process.exitCode = 1
    })
}

export function registerNoteCommands(program: Command): void {
  const note = program.command('note [text...]').action((text: string[]) => {
    throw forgottenNewHint(text.join(' '))
  })
  note
    .command('new <text>')
    .description('file a new observation or another sighting')
    .option('--project <name>', 'file the note for this project')
    .option('--same-as <reference>', 'record a sighting of this existing note')
    .option('--new', 'file a distinct note despite possible duplicates')
    .option('--area <area>', 'classify the note under this area')
    .option('--anchor-json <json>', 'use this explicit provenance anchor')
    .option('--json', 'write the filed note and candidates as JSON')
    .action(async (text, options: NoteOptions) => {
      open()
      await newNoteCommand(text, options)
    })
  note
    .command('list [text]')
    .description('list notes from the local record')
    .option('--project <X>', 'limit notes to this project')
    .option('--stale', 'include stale notes')
    .option('--session <ID>', 'limit notes to this session', repeat, [])
    .option('--actionable', 'list notes ready for disposition')
    .option('--kept', 'list notes acknowledged by the selected sessions')
    .option('--json', 'write the note rows as JSON')
    .option('--new', 'treat list as note text and show the filing remedy')
    .action((text: string | undefined, options: NoteOptions) => {
      if (text !== undefined || options.new) throw listAsTextHint()
      open()
      listNoteCommand(options)
    })
  registerNoteReferenceCommands(note)
  registerNoteMaintenanceCommands(note)
}

const forgottenNewHint = (text: string) =>
  new Error(
    `${PLATFORM_SLUG} note new <text> [--same-as LABEL|UUID|NUMBER|--new]; to file the text "${text}", put new before it`,
  )

const listAsTextHint = () =>
  new Error(
    `to file the text "list", use: ${PLATFORM_SLUG} note new "list" [--new|--same-as LABEL|UUID|NUMBER]`,
  )

export function noteFiledOutput(note: {
  label: string
  sightings: number
  record_id: string | null
}): string[] {
  return [
    `note ${note.label} filed; ${note.sightings} sighting${note.sightings === 1 ? '' : 's'}`,
    ...(note.record_id ? [`record ${note.record_id}`] : []),
  ]
}

export const NOTE_DUPLICATE_PROMPT = "Enter a note label for the same finding, or 'new':"
export const noteListLine = (note: { label: string; sightings: number; text: string }) =>
  `${note.label.padEnd(20)} x${note.sightings}  ${note.text}`
export const noteKeepLine = (note: { label: string }, already: boolean) =>
  `note ${note.label} ${already ? 'already kept' : 'kept'} for this session`
export const noteSameLine = (note: { label: string; sightings: number }) =>
  `note ${note.label} now has ${note.sightings} sightings`
export const noteDropLine = (note: { label: string; stale_reason: string | null }) =>
  `note ${note.label} dropped: ${note.stale_reason}`
export const noteStaleLine = (note: { label: string; reason: string }) =>
  `note ${note.label}: ${note.reason}`
export const noteCandidateLine = (note: { label: string; score: number; text: string }) =>
  `${note.label} score ${note.score.toFixed(3)}  ${note.text}`

export function noteFiledJson(
  note: {
    record_id: string
    number: number
    label: string
    sightings: number
  } | null,
  candidates: {
    record_id: string
    number: number
    label: string
    text: string
    score: number
  }[],
) {
  return {
    record_id: note?.record_id ?? null,
    number: note?.number ?? null,
    label: note?.label ?? null,
    sightings: note?.sightings ?? null,
    candidates,
  }
}
