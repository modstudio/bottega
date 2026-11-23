// concern: cli
/** Registers session lifecycle adapters. */

import { type Command, InvalidArgumentError, Option } from 'commander'
import { repeatable } from '../../../shared/cli-repeat-guard.ts'
import { collect, log } from './support.ts'

async function repairAskingTurnsBeforeServiceRead(): Promise<void> {
  const { db, storeWritesRefused } = await import('../database/db.ts')
  if (storeWritesRefused()) return
  const { repairAskingTurns } = await import('../run/run-liveness.ts')
  repairAskingTurns(db(), new Date().toISOString())
}

function stopSummaryBlockKey(value: string): string {
  if (!/^[0-9a-f]+$/i.test(value)) throw new InvalidArgumentError('block key must be hexadecimal')
  return value
}

function positivePid(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 1)
    throw new InvalidArgumentError('harness pid must be a positive process id')
  return parsed
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
    .option('--json', 'write the summary as JSON')
    .allowExcessArguments(false)
    .action(async (options) => {
      const [{ sessionId }, { sessionStopSummary }] = await Promise.all([
        import('../database/db.ts'),
        import('../session/stop-summary.ts'),
      ])
      if (options.blockKey && !options.stop)
        throw new Error('--block-key is only meaningful with --stop')
      const selectedSession = options.session ?? sessionId()
      if (!selectedSession) throw new Error('session identity is unavailable')
      const report = await sessionStopSummary({
        session: selectedSession,
        previousBlockKey: options.stop ? (options.blockKey ?? null) : null,
      })
      log(options.json ? JSON.stringify(report) : report.lines.join('\n'))
    })
}

function registerReport(session: Command): void {
  session
    .command('report')
    .description(
      'measure task-cursor attribution and residue over a session window\n\nRuns in the window fall into four classes: bound runs carry a cursor id; admitted runs are unbound keyed runs whose task had an open cursor when the run started; keyless runs have no launch key; and keyed-uncovered runs had no matching open task cursor when they started. Bound and admitted runs count as on a cursor, while the "runs without a cursor" total is keyless plus keyed-uncovered. The report shows admitted runs separately as "on a task cursor but not bound" so the binding gap remains visible.\n\nHook output is grouped by event and kind. Its repeated-unchanged share compares each in-window fingerprint with every earlier fingerprint in the same session, event and kind, including emissions before the window. Detached recording child failures are appended to the per-user state file `orchestrator/hook-emission.log`.\n\nUnanswered questions use the durable open-question predicate: neither answered nor closed. This differs from question inbox, which lists its needs-attention subset. Past-window admitted runs, unscored runs, and open cursors are marked approximate.',
    )
    .addOption(
      repeatable(
        new Option('--session <id>', 'select one session; repeat to select more')
          .argParser(collect)
          .default([]),
      ),
    )
    .option('--all', 'select every recorded session')
    .option('--since <date>', 'start the current window at this ISO date')
    .option('--until <date>', 'end the current window at this ISO date')
    .option('--compare <since>..<until>', 'compare against this second window')
    .option('--json', 'write the report as JSON')
    .allowExcessArguments(false)
    .action(async (options) => {
      const [{ sessionReport }, { formatSessionReport }] = await Promise.all([
        import('../session-report/session-report-adapter.ts'),
        import('../session-report/session-report-format.ts'),
      ])
      const report = await sessionReport({
        sessions: options.session,
        all: Boolean(options.all),
        since: options.since,
        until: options.until,
        compare: options.compare,
      })
      log(options.json ? JSON.stringify(report) : formatSessionReport(report))
    })
}

function registerStart(session: Command): void {
  session
    .command('start')
    .description(
      'open explore for a session that holds no open cursor, name the explore it holds, or name its open task cursor and open none',
    )
    .addOption(
      new Option('--harness-pid <pid>', 'publish the harness process session').argParser(
        positivePid,
      ),
    )
    .option('--source <source>', 'name the SessionStart source')
    .allowExcessArguments(false)
    .action(async (options) => {
      const { safeStartSession } = await import('../session/session-start.ts')
      log((await safeStartSession({ harnessPid: options.harnessPid, source: options.source })).line)
    })
}

export function register(program: Command): void {
  const session = program.command('session').description('manage the calling architect session')
  registerStatus(session)
  registerReport(session)
  registerStart(session)
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
      const [{ sessionLosses }, { formatSessionLosses }] = await Promise.all([
        import('../session-losses/session-losses-adapter.ts'),
        import('../session-losses/session-losses-format.ts'),
      ])
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
    .action(async (options) => {
      const { formatSessionHold, sessionHold } = await import('../session/session-hold.ts')
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
      await repairAskingTurnsBeforeServiceRead()
      const { closeOutSession, formatSessionCloseOut, SESSION_CLOSE_OUT_RESIDUE_EXIT_CODE } =
        await import('../session/session-close-out.ts')
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
    .action(async (target, options) => {
      const { adoptSessionRuns, formatSessionAdoption } = await import(
        '../session/session-adopt.ts'
      )
      const report = adoptSessionRuns(target, options.reason, {
        consent: options.cutOff ? 'cut-off' : 'standard',
      })
      log(options.json ? JSON.stringify(report) : formatSessionAdoption(report))
    })
}
