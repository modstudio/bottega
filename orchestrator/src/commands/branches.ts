// concern: cli
/** Registers the run-minted branch report. Must not own report behavior. */

import type { Command } from 'commander'
import { branchesReport, renderBranchesReport } from '../branches.ts'
import { log } from './support.ts'

export function register(program: Command): void {
  program
    .command('branches')
    .option('--project <name>')
    .option('--key <KEY>')
    .option('--json')
    .allowExcessArguments(false)
    .action((options) => {
      const report = branchesReport({ project: options.project, key: options.key })
      log(options.json ? JSON.stringify(report) : renderBranchesReport(report))
      if (report.projects.some((project) => project.error)) process.exitCode = 1
    })
}
