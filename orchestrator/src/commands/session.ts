// concern: cli
/** Registers session lifecycle adapters. */

import { type Command, InvalidArgumentError, Option } from 'commander'
import { repeatable } from '../../../shared/cli-repeat-guard.ts'
import { sessionId } from '../database/db.ts'
import { adoptSessionRuns, formatSessionAdoption } from '../session/session-adopt.ts'
import {
  closeOutSession,
  formatSessionCloseOut,
  SESSION_CLOSE_OUT_RESIDUE_EXIT_CODE,
} from '../session/session-close-out.ts'
import { formatSessionHold, sessionHold } from '../session/session-hold.ts'
import { safeStartSession } from '../session/session-start.ts'
import { type StopSummaryHookNote, sessionStopSummary } from '../session/stop-summary.ts'
import { sessionLosses } from '../session-losses/session-losses-adapter.ts'
import { formatSessionLosses } from '../session-losses/session-losses-format.ts'
import { collect, log } from './support.ts'

function stopSummaryBlockKey(value: string): string {
  if (!/^[0-9a-f]+$/i.test(value)) throw new InvalidArgumentError('block key must be hexadecimal')
  return value
}

function stopSummaryNotes(value: string): StopSummaryHookNote[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new InvalidArgumentError('notes must be a JSON array')
  }
  if (!Array.isArray(parsed)) throw new InvalidArgumentError('notes must be a JSON array')
  return parsed.map((item) => {
    if (!item || typeof item !== 'object')
      throw new InvalidArgumentError('each note must be an object')
    const note = item as Record<string, unknown>
    if (typeof note.label !== 'string' || !note.label)
      throw new InvalidArgumentError('each note must have a label')
    if (typeof note.project !== 'string' || !note.project)
      throw new InvalidArgumentError('each note must have a project')
    if (
      note.last_seen_at !== undefined &&
      note.last_seen_at !== null &&
      typeof note.last_seen_at !== 'string'
    )
      throw new InvalidArgumentError('note last_seen_at must be a string or null')
    return {
      label: note.label,
      project: note.project,
      ...(note.last_seen_at === undefined
        ? {}
        : { last_seen_at: note.last_seen_at as string | null }),
    }
  })
}

function registerStatus(session: Command): void {
  session
    .command('status')
    .description('summarize what is moving and what the calling session owes')
    .option('--stop', 'apply Stop-hook block-once state')
    .option('--session <id>', 'select the session to summarize')
    .addOption(
      new Option('--block-key <hex>', 'apply the previous Stop block key').argParser(
        stopSummaryBlockKey,
      ),
    )
    .addOption(
      new Option('--notes <json>', 'include actionable note rows').argParser((value) => ({
        rows: stopSummaryNotes(value),
      })),
    )
    .option('--json', 'write the summary as JSON')
    .allowExcessArguments(false)
    .action(async (options) => {
      if (options.blockKey && !options.stop)
        throw new Error('--block-key is only meaningful with --stop')
      const selectedSession = options.session ?? sessionId()
      if (!selectedSession) throw new Error('session identity is unavailable')
      const report = await sessionStopSummary({
        session: selectedSession,
        previousBlockKey: options.stop ? (options.blockKey ?? null) : null,
        notes: options.notes?.rows ?? [],
      })
      log(options.json ? JSON.stringify(report) : report.lines.join('\n'))
    })
}

export function register(program: Command): void {
  const session = program.command('session').description('manage the calling architect session')
  registerStatus(session)
  session
    .command('start')
    .description('open explore for a session that holds no open explore, or name the one it holds')
    .allowExcessArguments(false)
    .action(async () => {
      log((await safeStartSession()).line)
    })
  session
    .command('losses')
    .description('measure losses around Claude transcript compaction boundaries')
    .addOption(
      repeatable(
        new Option('--session <id>', 'select one session; repeat to select more')
          .argParser(collect)
          .default([]),
      ),
    )
    .option('--all', 'select every readable transcript')
    .option('--since <date>', 'include rows at or after this ISO date')
    .option('--json', 'write the report as JSON')
    .option('--judge', 'dispatch blind semantic-loss judges without waiting')
    .allowExcessArguments(false)
    .action(async (options) => {
      const report = await sessionLosses({
        sessions: options.session,
        all: Boolean(options.all),
        since: options.since,
        judge: Boolean(options.judge),
      })
      log(options.json ? JSON.stringify(report) : formatSessionLosses(report))
    })
  session
    .command('hold')
    .description('keep the heartbeat waiting for a board message to change')
    .option('--on <id>', 'hold for this board message')
    .option('--release <id>', 'release the hold on this board message')
    .option('--reason <text>', 'record why the hold was released')
    .allowExcessArguments(false)
    .action((options) => {
      log(formatSessionHold(sessionHold(options)))
    })
  session
    .command('close-out')
    .description('release and verify everything one session owns')
    .option('--session <id>', 'select a session other than the calling harness session')
    .option('--dry-run', 'report releases without changing anything')
    .option('--resume', 'keep session context items for a successor resume brief')
    .option('--json', 'write the close-out report as JSON')
    .allowExcessArguments(false)
    .action(async (options) => {
      const report = await closeOutSession({
        session: options.session,
        dryRun: options.dryRun,
        resume: options.resume,
      })
      log(options.json ? JSON.stringify(report) : formatSessionCloseOut(report))
      if (!report.verdict.clean) process.exitCode = SESSION_CLOSE_OUT_RESIDUE_EXIT_CODE
    })
  session
    .command('adopt <session>')
    .description("take over another session's run chains")
    .requiredOption('--reason <text>', 'record why this session is taking ownership')
    .option('--cut-off', 'adopt when every owner process is gone but last_seen is recent')
    .option('--json', 'write the adoption report as JSON')
    .allowExcessArguments(false)
    .action((target, options) => {
      const report = adoptSessionRuns(target, options.reason, {
        consent: options.cutOff ? 'cut-off' : 'standard',
      })
      log(options.json ? JSON.stringify(report) : formatSessionAdoption(report))
    })
}
