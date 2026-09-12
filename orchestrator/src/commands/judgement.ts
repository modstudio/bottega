// concern: cli
/** Registers judgement adapters and validates their CLI-only inputs. */
import type { Command } from 'commander'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { writableDb } from '../db.ts'
import { NOT_EVIDENCE } from '../failure.ts'
import { authorizeRunMutation } from '../run-authority.ts'
import { discardWorktree, type CleanupPresentation, type CleanupRow } from '../cleanup.ts'
import { judgeRun, scoreRun } from '../judgement.ts'
import { pidAlive } from '../process-liveness.ts'
import { recalibrate } from '../recalibration.ts'
import { DASHBOARD_CAPABILITY_PATH_ENV, DASHBOARD_CAPABILITY_TOKEN_ENV, type DashboardCapability } from '../../../shared/dashboard-capability.ts'
import { booleanOptions, cliFlags, rawArgv, valueOptions } from './support.ts'

const commonValueFlags = ['--finding', '--note', '--note-file', '--better-than', '--worse-than', '--same-as', '--reproduced', '--coverage', '--limits', '--overlap'] as const
const valueFlags = new Set([...commonValueFlags, '--scorer'])

function scoreNote(flags: ReturnType<typeof cliFlags>): string | null {
  const inline = flags.flag('note'); const file = flags.flag('note-file')
  if (inline !== undefined && file !== undefined) throw new Error('pass a score note with either --note or --note-file, not both')
  const note = file === undefined ? inline : readFileSync(file, 'utf8')
  if (note === undefined) return null
  const unescaped = (quote: string) => {
    let count = 0
    for (let i = 0; i < note.length; i++) {
      if (note[i] !== quote) continue
      if (quote === "'" && /[\p{L}\p{N}]/u.test(note[i - 1] ?? '') && /[\p{L}\p{N}]/u.test(note[i + 1] ?? '')) continue
      let slashes = 0
      for (let j = i - 1; j >= 0 && note[j] === '\\'; j--) slashes++
      if (slashes % 2 === 0) count++
    }
    return count
  }
  if (note.trim() === '``' || ['"', "'", '`'].some((quote) => unescaped(quote) % 2 !== 0)) {
    throw new Error('score note looks like an unexpanded shell fragment (a lone backtick pair or an unbalanced quote); put the note in a file and pass --note-file <path>')
  }
  return note
}

function auditReason(flags: ReturnType<typeof cliFlags>): string | null {
  const scorer = flags.flag('scorer')
  if (scorer) return `--scorer ${scorer}`
  if (flags.has('force')) return '--force'
  return flags.flag('unreviewed') ?? flags.flag('note') ?? null
}

function dashboardScoreAuthorized(scorer: string | undefined): boolean {
  if (scorer !== 'hub-dashboard') return false
  const path = process.env[DASHBOARD_CAPABILITY_PATH_ENV]; const presented = process.env[DASHBOARD_CAPABILITY_TOKEN_ENV]
  if (!path || !presented || typeof process.getuid !== 'function') return false
  try {
    const uid = process.getuid(); const file = lstatSync(path); const dir = lstatSync(dirname(path))
    if (!file.isFile() || file.isSymbolicLink() || !dir.isDirectory() || dir.isSymbolicLink()) return false
    if (file.uid !== uid || dir.uid !== uid || (file.mode & 0o777) !== 0o600 || (dir.mode & 0o777) !== 0o700) return false
    const capability = JSON.parse(readFileSync(path, 'utf8')) as DashboardCapability
    if (!Number.isInteger(capability.pid) || capability.pid < 1 || typeof capability.token !== 'string') return false
    const expected = Buffer.from(capability.token); const actual = Buffer.from(presented)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || !pidAlive(capability.pid)) return false
    const observed = Bun.spawnSync(['ps', '-p', String(capability.pid), '-o', 'command='], { stdout: 'pipe', stderr: 'pipe' })
    if (observed.exitCode !== 0) return false
    const words = new TextDecoder().decode(observed.stdout).trim().split(/\s+/)
    return words.some((word, index) => (word === 'hub' || word.endsWith('/bin/hub') || word.endsWith('/hub/src/cli.ts')) && words[index + 1] === 'serve')
  } catch { return false }
}

function pairHint(partner: { id: number; agent: string }): string {
  const reason = 'reason' in partner ? String(partner.reason) : 'same task'
  return `pair: run ${partner.id} (${partner.agent}) is comparable (${reason}) — record with --better-than ${partner.id} | --worse-than ${partner.id} | --same-as ${partner.id}`
}

const cleanupPresentation: CleanupPresentation = {
  log: (...values) => console.log(...values), error: (...values) => console.error(...values),
  setExitCode: (code) => { process.exitCode = code },
  keptBranchLine: (branch, unique, after, id) => `kept branch ${branch}: ${after === null ? `${unique} commit(s) reachable only from this branch` : `deleting it would lose commits reachable from no other ref; ${after} commit(s) after the cut`} — merge it, or orch discard ${id} --force to delete it after checking no other run owns it`,
}

function addJudgementOptions(command: Command, judge: boolean): Command {
  const names = judge ? commonValueFlags : [...commonValueFlags, '--scorer']
  valueOptions(command, names.map((name) => name.slice(2)))
  return booleanOptions(command, judge ? ['discard', 'force'] : ['force', 'void'])
}

export function register(program: Command): void {
  addJudgementOptions(program.command('judge <run-id> [words...]'), true).action((id, _words, _options, command) => {
    const argv = rawArgv(command); const flags = cliFlags(argv); writableDb()
    const words = argv.slice(2).filter((arg, index, rest) => !arg.startsWith('--') && !valueFlags.has(rest[index - 1] ?? ''))
    const result = judgeRun(Number(id), flags, { words, note: scoreNote(flags), auditReason: auditReason(flags), notEvidence: NOT_EVIDENCE }, { log: console.log, error: console.error, pairHint })
    if (flags.has('discard')) {
      if (!result.row.worktree) throw new Error(`run ${result.id} has no worktree to discard`)
      discardWorktree(result.row as CleanupRow, 'discarded', false, authorizeRunMutation(result.id, 'discard'), { force: false, auditReason: auditReason(flags), presentation: cleanupPresentation })
    }
  })

  addJudgementOptions(program.command('score <run-id> [words...]'), false).action((id, _words, _options, command) => {
    const argv = rawArgv(command); const flags = cliFlags(argv); writableDb()
    const words = argv.slice(2).filter((arg, index, rest) => !arg.startsWith('--') && !valueFlags.has(rest[index - 1] ?? ''))
    scoreRun(Number(id), flags, { words, note: scoreNote(flags), auditReason: auditReason(flags), dashboardAuthorized: dashboardScoreAuthorized(flags.flag('scorer')), notEvidence: NOT_EVIDENCE }, { log: console.log, error: console.error, pairHint })
  })

  const recalibration = valueOptions(program.command('recalibrate'), ['n', 'scorer'])
  booleanOptions(recalibration, ['force']).action(async (_options, command) => {
    await recalibrate(cliFlags(rawArgv(command)), { log: console.log, write: (value) => process.stdout.write(value), input: process.stdin, output: process.stdout })
  })
}
