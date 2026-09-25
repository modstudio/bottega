// concern: cli
/** Registers judgment adapters and validates their CLI-only inputs. */

import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import { type CleanupPresentation, type CleanupRow, discardWorktree } from '../cleanup/cleanup.ts'
import { dashboardCapabilityAuthorized } from '../dashboard-capability.ts'
import { writableDb } from '../database/db.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { judgeRun, scoreRun } from '../judgment.ts'
import { authorizeRunMutation } from '../run/run-authority.ts'
import { recalibrate } from '../score/recalibration.ts'
import { collect, log, optionFlags, write } from './support.ts'

const commonValueFlags = [
  '--finding',
  '--note',
  '--note-file',
  '--better-than',
  '--worse-than',
  '--same-as',
  '--reproduced',
  '--coverage',
  '--limits',
  '--overlap',
] as const

export function scoreNote(flags: ReturnType<typeof optionFlags>): string | null {
  const inline = flags.flag('note')
  const file = flags.flag('note-file')
  if (inline !== undefined && file !== undefined)
    throw new Error('pass a score note with either --note or --note-file, not both')
  if (file !== undefined) return readFileSync(file, 'utf8')
  const note = inline
  if (note === undefined) return null
  if (/^`{1,2}$/.test(note.trim())) {
    throw new Error(
      'score note looks like an unexpanded shell fragment (a lone backtick); put the note in a file and pass --note-file <path>',
    )
  }
  return note
}

function auditReason(flags: ReturnType<typeof optionFlags>): string | null {
  const scorer = flags.flag('scorer')
  if (scorer) return `--scorer ${scorer}`
  if (flags.has('force')) return '--force'
  return flags.flag('unreviewed') ?? flags.flag('note') ?? null
}

function pairHint(partner: { id: number; agent: string }): string {
  const reason = 'reason' in partner ? String(partner.reason) : 'same task'
  return `pair: run ${partner.id} (${partner.agent}) is comparable (${reason}) — record with --better-than ${partner.id} | --worse-than ${partner.id} | --same-as ${partner.id}`
}

const cleanupPresentation: CleanupPresentation = {
  log: log,
  error: (...values) => console.error(...values),
  setExitCode: (code) => {
    process.exitCode = code
  },
  keptBranchLine: (branch, unique, after, id) =>
    `kept branch ${branch}: ${after === null ? `${unique} commit(s) reachable only from this branch` : `deleting it would lose commits reachable from no other ref; ${after} commit(s) after the cut`} — merge it, or orch discard ${id} --force to delete it after checking no other run owns it`,
}

function addJudgmentOptions(command: Command, judge: boolean): Command {
  command.option('--finding <value>', '', collect, [])
  for (const name of commonValueFlags.filter((name) => name !== '--finding'))
    command.option(`${name} <value>`)
  if (!judge) command.option('--scorer <value>')
  command.option('--force').allowExcessArguments(false)
  return judge
    ? command.option('--discard')
    : command.option('--void').option('--unvoid').option('--blocked-by-tree')
}

export function register(program: Command): void {
  addJudgmentOptions(program.command('judge <run-id> [words...]'), true).action(
    async (id, words, options) => {
      const flags = optionFlags(options)
      writableDb()
      const result = await judgeRun(
        Number(id),
        flags,
        {
          words,
          note: scoreNote(flags),
          auditReason: auditReason(flags),
          notEvidence: NOT_EVIDENCE,
        },
        { log, error: console.error, pairHint },
      )
      if (flags.has('discard')) {
        if (!result.row.worktree) throw new Error(`run ${result.id} has no worktree to discard`)
        discardWorktree(
          result.row as CleanupRow,
          'discarded',
          false,
          authorizeRunMutation(result.id, 'discard'),
          { force: false, auditReason: auditReason(flags), presentation: cleanupPresentation },
        )
      }
    },
  )

  addJudgmentOptions(program.command('score <run-id> [words...]'), false).action(
    async (id, words, options) => {
      const flags = optionFlags(options)
      writableDb()
      await scoreRun(
        Number(id),
        flags,
        {
          words,
          note: scoreNote(flags),
          auditReason: auditReason(flags),
          dashboardAuthorized:
            flags.flag('scorer') === 'hub-dashboard' && dashboardCapabilityAuthorized(),
          notEvidence: NOT_EVIDENCE,
        },
        { log, error: console.error, pairHint },
      )
    },
  )

  program
    .command('recalibrate')
    .option('--n <value>')
    .option('--scorer <value>')
    .option('--force')
    .allowExcessArguments(false)
    .action(async (options) => {
      await recalibrate(optionFlags(options), {
        log,
        write,
        input: process.stdin,
        output: process.stdout,
      })
    })
}
