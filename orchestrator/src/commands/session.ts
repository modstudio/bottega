// concern: cli
/** Registers session lifecycle adapters. */

import type { Command } from 'commander'
import { adoptSessionRuns, formatSessionAdoption } from '../session/session-adopt.ts'
import {
  closeOutSession,
  formatSessionCloseOut,
  SESSION_CLOSE_OUT_RESIDUE_EXIT_CODE,
} from '../session/session-close-out.ts'
import { log } from './support.ts'

export function register(program: Command): void {
  const session = program.command('session').description('manage the calling architect session')
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
    .option('--json', 'write the adoption report as JSON')
    .allowExcessArguments(false)
    .action((target, options) => {
      const report = adoptSessionRuns(target, options.reason)
      log(options.json ? JSON.stringify(report) : formatSessionAdoption(report))
    })
}
