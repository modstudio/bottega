// concern: cli
/** Registers the run-minted branch report. Must not own report behavior. */

import type { Command } from 'commander'
import { recordBranchLanding } from '../branch/branch-landing-service.ts'
import {
  branchesReport,
  pruneBranches,
  pruneOtherBranches,
  renderBranchesReport,
  renderBranchPruneReport,
} from '../branch/branches.ts'
import { log } from './support.ts'

export function register(program: Command): void {
  const branches = program
    .command('branches')
    .option('--project <name>')
    .option('--key <KEY>')
    .option('--all-local')
    .option('--json')
    .passThroughOptions()
    .allowExcessArguments(false)
    .action((options) => {
      const report = branchesReport({
        project: options.project,
        key: options.key,
        allLocal: options.allLocal,
        repairLandings: true,
      })
      log(options.json ? JSON.stringify(report) : renderBranchesReport(report))
      if (report.projects.some((project) => project.error)) process.exitCode = 1
    })

  branches
    .command('landed')
    .argument('<branch>')
    .requiredOption('--pr <number>')
    .option('--json')
    .allowExcessArguments(false)
    .action((branch, options) => {
      const report = recordBranchLanding(branch, Number(options.pr))
      log(
        options.json
          ? JSON.stringify(report)
          : `${report.branch}: recorded PR #${report.number} (merge ${report.mergeCommit ?? 'none'}, ${report.mergedAt})${report.localTipDiffersFromPrHead ? '; local tip differs from PR headRefOid' : ''}`,
      )
    })

  branches
    .command('prune')
    .requiredOption('--project <name>')
    .option('--key <KEY>')
    .option('--all-local')
    .option('--dry-run')
    .option('--json')
    .allowExcessArguments(false)
    .action((options) => {
      if (Boolean(options.key) === Boolean(options.allLocal)) {
        throw new Error('orch branches prune requires exactly one of --key <KEY> or --all-local')
      }
      const report = options.allLocal
        ? pruneOtherBranches({ project: options.project, dryRun: options.dryRun })
        : pruneBranches({ project: options.project, key: options.key, dryRun: options.dryRun })
      log(options.json ? JSON.stringify(report) : renderBranchPruneReport(report))
      if (report.errors.length) process.exitCode = 1
    })
}
