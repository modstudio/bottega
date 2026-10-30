// concern: cli
/** Registers session lifecycle adapters. */

import type { Command } from 'commander'
import { adoptSessionRuns, formatSessionAdoption } from '../session/session-adopt.ts'
import {
  closeOutSession,
  formatSessionCloseOut,
  SESSION_CLOSE_OUT_RESIDUE_EXIT_CODE,
} from '../session/session-close-out.ts'
import { formatSessionHold, sessionHold } from '../session/session-hold.ts'
import { sessionLosses } from '../session-losses/session-losses-adapter.ts'
import { formatSessionLosses } from '../session-losses/session-losses-format.ts'
import { collect, log } from './support.ts'

export function register(program: Command): void {
  const session = program.command('session').description('manage the calling architect session')
  session
    .command('losses')
    .description('measure losses around Claude transcript compaction boundaries')
    .option('--session <id>', 'select one session; repeat to select more', collect, [])
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
    .option('--json', 'write the close-out report as JSON')
    .allowExcessArguments(false)
    .action((options) => {
      const report = closeOutSession({ session: options.session, dryRun: options.dryRun })
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
