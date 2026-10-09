import { projectOf } from './attribute.ts'
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

const option = (argv: string[], name: string) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const options = (argv: string[], name: string) =>
  argv.flatMap((value, index) =>
    value === `--${name}` && argv[index + 1] ? [argv[index + 1]!] : [],
  )
const hasOption = (argv: string[], name: string) => argv.includes(`--${name}`)

function explicitNoteAnchor(argv: string[]): Parameters<typeof createNote>[0]['anchor'] {
  const value = option(argv, 'anchor-json')
  return value ? parseExplicitNoteAnchor(JSON.parse(value)) : undefined
}

export async function runNoteCommand(argv: string[]): Promise<void> {
  const sub = argv[1]
  const flag = (name: string) => option(argv, name)
  const has = (name: string) => hasOption(argv, name)
  const reference = (value: string) => resolveNoteReference(value, projectOf(process.cwd()))
  refuseAmbiguousNoteVerb(argv, sub)
  if (sub === 'push') return pushNoteCache(argv)
  if (sub === 'list') {
    if (argv[2] && !argv[2]!.startsWith('--')) {
      throw new Error(
        'to file the text "list", use: hub note new "list" [--new|--same-as LABEL|UUID|NUMBER]',
      )
    }
    if (has('actionable') && has('kept'))
      throw new Error('--actionable and --kept are mutually exclusive')
    const sessions = options(argv, 'session')
    if (has('kept') && !sessions.length && noteSessionId()) sessions.push(noteSessionId()!)
    if (has('kept') && !sessions.length)
      throw new Error('hub note list --kept requires --session ID or a session environment')
    const session = sessions.length ? sessions : undefined
    const rows = has('actionable')
      ? listActionableNotes({ project: flag('project'), session })
      : listNotes({ project: flag('project'), stale: has('stale'), session, kept: has('kept') })
    if (has('json')) console.log(JSON.stringify(rows))
    else if (!rows.length) console.log('no notes')
    else for (const row of rows) console.log(noteListLine(row))
    return
  }
  if (sub === 'keep') {
    const ids = argv.slice(2).filter((value) => !value.startsWith('--'))
    if (!ids.length) throw new Error('hub note keep <LABEL|UUID|NUMBER>...')
    const session = noteSessionId()
    if (!session) throw new Error('hub note keep requires a session environment')
    for (const id of ids) {
      const result = await acknowledgeNote(reference(id), session)
      console.log(noteKeepLine(result.note, result.alreadyAcknowledged))
    }
    return
  }
  if (sub === 'same') {
    const row = await mergeNote(reference(argv[2] ?? ''), reference(argv[3] ?? ''))
    console.log(noteSameLine(row))
    return
  }
  if (sub === 'promote') {
    const row = await promoteNoteCommand(reference(argv[2] ?? ''), flag('task'), has('task'))
    console.log(`${row.promoted_task}`)
    return
  }
  if (sub === 'drop') {
    const reason = flag('reason')
    if (!reason) throw new Error('hub note drop <LABEL|UUID|NUMBER> --reason "..."')
    const row = await dropNote(reference(argv[2] ?? ''), reason)
    console.log(noteDropLine(row))
    return
  }
  if (sub === 'stale') {
    const result = await staleNotes()
    for (const row of result.reasons) console.log(noteStaleLine(row))
    console.log(`${result.marked} marked stale; ${result.deleted} deleted`)
    return
  }
  if (sub === 'curate') {
    const results = await curateNotes(has('scheduled'))
    if (has('scheduled') && !curatorEnabled()) {
      console.log('note curator is disabled')
      return
    }
    for (const result of results) console.log(`${result.project}: ${result.result}`)
    return
  }
  if (sub === 'curator') {
    if (has('enable') === has('disable')) {
      console.log(`note curator is ${curatorEnabled() ? 'enabled' : 'disabled'}`)
      return
    }
    console.log(`note curator ${setCuratorEnabled(has('enable')) ? 'enabled' : 'disabled'}`)
    return
  }
  if (sub !== 'new') {
    throw new Error(
      `hub note new <text> [--same-as LABEL|UUID|NUMBER|--new]; to file the text "${sub ?? ''}", put new before it`,
    )
  }
  const text = argv[2] ?? ''
  const same = flag('same-as')
  let result = await createNote({
    text,
    area: flag('area'),
    sameAs: same ? reference(same) : undefined,
    forceNew: has('new'),
    anchor: explicitNoteAnchor(argv),
  })
  if (!result.note) {
    if (has('json')) {
      console.log(JSON.stringify(noteFiledJson(null, result.candidates)))
      return
    }
    const lines = result.candidates.map(noteCandidateLine)
    if (!process.stdin.isTTY) {
      throw new Error(
        `possible duplicate notes:\n${lines.join('\n')}\nPass --same-as <LABEL|UUID|NUMBER> or --new.`,
      )
    }
    console.log(`possible duplicate notes:\n${lines.join('\n')}`)
    const answer = prompt(NOTE_DUPLICATE_PROMPT)?.trim() ?? ''
    result =
      answer && answer !== 'new'
        ? await createNote({ text, area: flag('area'), sameAs: reference(answer) })
        : answer === 'new'
          ? await createNote({ text, area: flag('area'), forceNew: true })
          : result
    if (!result.note) throw new Error('note not filed')
  }
  if (has('json')) console.log(JSON.stringify(noteFiledJson(result.note, result.candidates)))
  else {
    for (const candidate of result.candidates) console.log(`near ${noteCandidateLine(candidate)}`)
    for (const line of noteFiledOutput(result.note)) console.log(line)
  }
}

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
  note: { record_id: string; number: number; label: string; sightings: number } | null,
  candidates: { record_id: string; number: number; label: string; text: string; score: number }[],
) {
  return {
    record_id: note?.record_id ?? null,
    number: note?.number ?? null,
    label: note?.label ?? null,
    sightings: note?.sightings ?? null,
    candidates,
  }
}

function refuseAmbiguousNoteVerb(argv: string[], sub: string | undefined): void {
  const verbs = new Set([
    'list',
    'same',
    'keep',
    'promote',
    'drop',
    'stale',
    'curate',
    'curator',
    'push',
  ])
  if (sub && verbs.has(sub) && (hasOption(argv, 'new') || option(argv, 'same-as'))) {
    throw new Error(
      `to file the text "${sub}", use: hub note new "${sub}" [--new|--same-as LABEL|UUID|NUMBER]`,
    )
  }
}

async function pushNoteCache(argv: string[]): Promise<void> {
  const result = await pushNotes({ dryRun: hasOption(argv, 'dry-run') })
  console.log(JSON.stringify(result, null, 2))
  if (result.match === false) process.exitCode = 1
}
