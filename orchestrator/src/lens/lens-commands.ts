// concern: review
/** Owns lens registry command decisions. Must not know CLI grammar. */
import { readFileSync } from 'node:fs'
import { flagValue } from '../cli/args.ts'
import { db } from '../database/db.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import {
  lensProfileSpace,
  listLenses,
  listProfiles,
  setLens,
  setProfile,
  showLens,
  showProfile,
} from './lenses.ts'

type LensPresentation = { log(value: string): void }
type Emit = (value: unknown, line?: string) => void

export function lensEmitter(argv: string[], presentation: LensPresentation): Emit {
  const json = argv.includes('--json')
  return (value, line) =>
    presentation.log(json ? JSON.stringify(value) : (line ?? JSON.stringify(value, null, 2)))
}

export function listLensesCommand(emit: Emit): void {
  const rows = listLenses()
  emit(
    rows,
    rows
      .map(
        (row) =>
          `${row.id}  v${row.version}  ${row.enabled ? 'enabled' : 'disabled'}  ${row.requires_execution ? 'requires execution' : 'reading only'}  ${row.title}`,
      )
      .join('\n'),
  )
}

export function showLensCommand(argv: string[], emit: Emit): void {
  const row = showLens(argv[2]!)
  if (!row) throw new Error(`no lens "${argv[2]}"`)
  emit(row)
}

const enabled = (argv: string[]) => {
  const value = flagValue(argv, 'enabled')
  if (value !== 'true' && value !== 'false') throw new Error('--enabled must be true or false')
  return value === 'true'
}
const booleanFlag = (argv: string[], name: string) => {
  const value = flagValue(argv, name)
  if (value !== 'true' && value !== 'false') throw new Error(`--${name} must be true or false`)
  return value === 'true'
}
const source = (argv: string[], inline: string, file: string) => {
  const value = flagValue(argv, inline),
    path = flagValue(argv, file)
  if ((value === undefined) === (path === undefined))
    throw new Error(`pass exactly one of --${inline} or --${file}`)
  return path ? readFileSync(path, 'utf8') : value!
}
export async function setLensCommand(argv: string[], emit: Emit): Promise<void> {
  const flag = (name: string) => flagValue(argv, name),
    id = argv[2],
    title = flag('title'),
    question = flag('question'),
    excludes = flag('excludes'),
    reason = flag('reason')
  if (
    !id ||
    title === undefined ||
    question === undefined ||
    excludes === undefined ||
    !reason?.trim()
  )
    throw new Error(
      'lens set requires id, title, question, excludes, enabled, requires-execution, slots, and reason',
    )
  emit(
    await setLens({
      id,
      title,
      question,
      excludes,
      slots: source(argv, 'slots', 'slots-file'),
      enabled: enabled(argv),
      requiresExecution: booleanFlag(argv, 'requires-execution'),
      reason,
    }),
  )
}

const profileProject = (argv: string[], cwd: string): string | null => {
  const named = flagValue(argv, 'project')
  if (named && !projectByName(named)) throw new Error(`no project "${named}"`)
  return named ?? projectAt(cwd)?.name ?? null
}

export function listProfilesCommand(argv: string[], emit: Emit, cwd: string = process.cwd()): void {
  const id = argv[3]
  const project = profileProject(argv, cwd)
  const database = db()
  const rows = listProfiles(id, database, lensProfileSpace(project, database))
  emit(
    rows,
    rows
      .map(
        (row) =>
          `${row.lens_id}  ${row.axis}/${row.name}  v${row.version}  ${row.enabled ? 'enabled' : 'disabled'}`,
      )
      .join('\n'),
  )
}

export function showProfileCommand(argv: string[], emit: Emit): void {
  const row = showProfile(argv[3]!, flagValue(argv, 'axis')!, flagValue(argv, 'name')!)
  if (!row) throw new Error('no such lens profile')
  emit(row)
}

export async function setProfileCommand(
  argv: string[],
  emit: Emit,
  cwd: string = process.cwd(),
): Promise<void> {
  const flag = (name: string) => flagValue(argv, name),
    id = argv[3],
    reason = flag('reason')
  if (!id || !flag('axis') || !flag('name') || !reason?.trim())
    throw new Error('lens profile set requires lens, axis, name, enabled, body, and reason')
  emit(
    await setProfile({
      lensId: id,
      project: profileProject(argv, cwd) ?? undefined,
      axis: flag('axis')!,
      name: flag('name')!,
      body: source(argv, 'body', 'body-file'),
      enabled: enabled(argv),
      reason,
    }),
  )
}
