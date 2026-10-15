// concern: cli
/** Registers judgment adapters and validates their CLI-only inputs. */

import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type CleanupPresentation, type CleanupRow, discardWorktree } from '../cleanup/cleanup.ts'
import { dashboardCapabilityAuthorized } from '../dashboard-capability.ts'
import { db, writableDb } from '../database/db.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { job } from '../jobs/jobs.ts'
import { judgeRun, scoreRun } from '../judgment.ts'
import { authorizeRunMutation } from '../run/run-authority.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { recalibrate } from '../score/recalibration.ts'
import type { CliFlags } from './support.ts'
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

const comparisonFlags = new Set(['better-than', 'worse-than', 'same-as'])

export function resolveComparisonRunIds(flags: CliFlags): CliFlags {
  return {
    ...flags,
    flag: (name) => {
      const value = flags.flag(name)
      if (value === undefined || !comparisonFlags.has(name)) return value
      const ids = value.split(',').map((part) => resolveRunIdentifier(db(), part))
      if (new Set(ids).size !== ids.length) {
        throw new Error(`--${name} names the same run more than once`)
      }
      return ids.join(',')
    },
  }
}

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
    `kept branch ${branch}: ${after === null ? `${unique} commit(s) reachable only from this branch` : `deleting it would lose commits reachable from no other ref; ${after} commit(s) after the cut`} — merge it, or ${PLATFORM_SLUG} run discard ${id} --force to delete it after checking no other run owns it`,
}

function addJudgmentOptions(command: Command): Command {
  command.option('--finding <value>', '', collect, [])
  for (const name of commonValueFlags.filter((name) => name !== '--finding'))
    command.option(`${name} <value>`)
  return command
    .option('--scorer <value>')
    .option('--force')
    .option('--discard')
    .option('--void')
    .option('--unvoid')
    .option('--blocked-by-tree')
    .allowExcessArguments(false)
}

/** Options only the score path acts on: voiding, a tree block and the scorer label. */
const SCORE_PATH_OPTIONS = ['void', 'unvoid', 'blocked-by-tree', 'scorer'] as const

/** Options only the judge path reads; the score path would drop them silently. */
const JUDGE_PATH_OPTIONS = ['discard', 'finding'] as const

/**
 * A findings run is judged with its axes and finding verdicts unless a score-path
 * option is given; voiding a lens run must void it rather than be dropped. The
 * score path reads neither finding verdicts nor `--discard`, so it refuses them.
 */
export function scorePathForJob(
  jobName: string,
  given: (name: string) => boolean = () => false,
): 'judge' | 'score' {
  const scoreOption = SCORE_PATH_OPTIONS.some(given)
  if (job(jobName).findings && !scoreOption) return 'judge'
  const dropped = JUDGE_PATH_OPTIONS.filter(given)
  if (dropped.length)
    throw new Error(
      `${dropped.map((name) => `--${name}`).join(' and ')} applies only when judging a findings run; drop it or the ${SCORE_PATH_OPTIONS.map((name) => `--${name}`).join(', ')} option`,
    )
  return 'score'
}

function rootJob(runId: number): string {
  const row = db()
    .query<{ job: string }, [number]>(
      `SELECT root.job FROM run requested
       JOIN run root ON root.id=COALESCE(requested.parent_run_id,requested.id)
       WHERE requested.id=?`,
    )
    .get(runId)
  if (!row) throw new Error(`no run ${runId}`)
  return row.job
}

export function register(program: Command): void {
  addJudgmentOptions(program.command('score <run-id> [words...]').alias('judge')).action(
    async (id, words, options) => {
      const flags = resolveComparisonRunIds(optionFlags(options))
      writableDb()
      const runId = resolveRunIdentifier(db(), id)
      const given = (name: string) =>
        name === 'finding' ? flags.values('finding').length > 0 : flags.has(name)
      if (scorePathForJob(rootJob(runId), given) === 'judge') {
        const result = await judgeRun(
          runId,
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
        return
      }
      await scoreRun(
        runId,
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
