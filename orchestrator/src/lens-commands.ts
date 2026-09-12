// concern: review
/** Owns lens registry command decisions. Must not know CLI grammar. */
import { readFileSync } from 'node:fs'
import { flagValue } from './args.ts'
import { listLenses, listProfiles, setLens, setProfile, showLens, showProfile } from './lenses.ts'

export function lensCommand(argv: string[], presentation: { log(value: string): void }): void {
  const sub = argv[1]; const json = argv.includes('--json')
  const emit = (value: unknown, line?: string) => presentation.log(json ? JSON.stringify(value) : (line ?? JSON.stringify(value, null, 2)))
  if (sub === 'list') { const rows = listLenses(); emit(rows, rows.map((row) => `${row.id}  v${row.version}  ${row.enabled ? 'enabled' : 'disabled'}  ${row.title}`).join('\n')) }
  else if (sub === 'show') { const row = showLens(argv[2]!); if (!row) throw new Error(`no lens "${argv[2]}"`); emit(row) }
  else if (sub === 'set') setLensCommand(argv, emit)
  else if (sub === 'profile') profileCommand(argv, emit)
  else throw new Error('unknown: orch lens. Try list | show | set | profile')
}

const enabled = (argv: string[]) => { const value = flagValue(argv, 'enabled'); if (value !== 'true' && value !== 'false') throw new Error('--enabled must be true or false'); return value === 'true' }
const source = (argv: string[], inline: string, file: string) => { const value = flagValue(argv, inline), path = flagValue(argv, file); if ((value === undefined) === (path === undefined)) throw new Error(`pass exactly one of --${inline} or --${file}`); return path ? readFileSync(path, 'utf8') : value! }
type Emit = (value: unknown, line?: string) => void

function setLensCommand(argv: string[], emit: Emit): void {
  const flag = (name: string) => flagValue(argv, name), id = argv[2], title = flag('title'), question = flag('question'), excludes = flag('excludes'), reason = flag('reason')
  if (!id || title === undefined || question === undefined || excludes === undefined || !reason?.trim()) throw new Error('lens set requires id, title, question, excludes, enabled, slots, and reason')
  emit(setLens({ id, title, question, excludes, slots: source(argv, 'slots', 'slots-file'), enabled: enabled(argv), reason }))
}

function profileCommand(argv: string[], emit: Emit): void {
  const flag = (name: string) => flagValue(argv, name), action = argv[2], id = argv[3]
  if (action === 'list') { const rows = listProfiles(id); emit(rows, rows.map((row) => `${row.lens_id}  ${row.axis}/${row.name}  v${row.version}  ${row.enabled ? 'enabled' : 'disabled'}`).join('\n')); return }
  if (action === 'show') { const row = showProfile(id!, flag('axis')!, flag('name')!); if (!row) throw new Error('no such lens profile'); emit(row); return }
  if (action === 'set') { const reason = flag('reason'); if (!id || !flag('axis') || !flag('name') || !reason?.trim()) throw new Error('lens profile set requires lens, axis, name, enabled, body, and reason'); emit(setProfile({ lensId: id, axis: flag('axis')!, name: flag('name')!, body: source(argv, 'body', 'body-file'), enabled: enabled(argv), reason })); return }
  throw new Error('unknown: orch lens profile. Try list | show | set')
}
