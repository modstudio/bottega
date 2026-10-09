// concern: subject-commands
/** Owns subject command semantics and presentation. */
import {
  addSubject,
  defineSubject,
  listSubjects,
  renameSubject,
  reorderSubjects,
  resolveSubject,
  retireSubject,
  type Subject,
} from './subjects.ts'

type Flags = { has(name: string): boolean; flag(name: string): string | undefined }
type Presentation = { log(...values: unknown[]): void }

const required = (value: string | undefined, description: string): string => {
  if (!value?.trim()) throw new Error(`${description} is required`)
  return value
}

const print = (rows: Subject[], flags: Flags, presentation: Presentation): void => {
  if (flags.has('json')) {
    presentation.log(JSON.stringify(rows))
    return
  }
  for (const row of rows) {
    presentation.log(
      `${String(row.position + 1).padStart(3)}  ${row.name}  ${row.definition}${row.retiredAt ? '  retired' : ''}  ${row.id}`,
    )
  }
}

export async function subjectCommand(
  verb: string,
  argv: string[],
  flags: Flags,
  presentation: Presentation,
): Promise<void> {
  const project = required(argv[2], 'project')
  if (verb === 'list') {
    const includeRetired = flags.has('retired')
    const rows = listSubjects(project, { retired: includeRetired })
    print(rows, flags, presentation)
    if (rows.length === 0 && !flags.has('json')) {
      const qualifier =
        !includeRetired && listSubjects(project, { retired: true }).length > 0 ? 'live ' : ''
      presentation.log(
        `project ${project} has no ${qualifier}subjects; add one with: orch subject add ${project} <name> --definition <definition>`,
      )
    }
    return
  }
  if (verb === 'add') {
    const row = await addSubject({
      project,
      name: required(argv[3], 'name'),
      definition: required(flags.flag('definition'), '--definition'),
    })
    print([row], flags, presentation)
    return
  }
  if (verb === 'rename') {
    const target = resolveSubject(project, required(argv[3], 'subject id or name'))
    print(
      [await renameSubject(project, target.id, required(argv[4], 'new name'))],
      flags,
      presentation,
    )
    return
  }
  if (verb === 'define') {
    const target = resolveSubject(project, required(argv[3], 'subject id or name'))
    print(
      [await defineSubject(project, target.id, required(flags.flag('definition'), '--definition'))],
      flags,
      presentation,
    )
    return
  }
  if (verb === 'reorder') {
    const references = argv.slice(3)
    const ids = references.map((reference) => resolveSubject(project, reference).id)
    print(await reorderSubjects(project, ids), flags, presentation)
    return
  }
  if (verb === 'retire') {
    const target = resolveSubject(project, required(argv[3], 'subject id or name'))
    print([await retireSubject(project, target.id)], flags, presentation)
    return
  }
  throw new Error(`unknown subject command "${verb}"; use orch subject --help`)
}
