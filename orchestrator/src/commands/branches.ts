// concern: cli
/** Registers the run-minted branch report. Must not own report behavior. */

import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
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
    .description('report run-minted branches and their landing state')
    .option('--project <name>', 'limit the report to this project')
    .option('--key <KEY>', 'limit the report to this task key')
    .option('--all-local', 'include local branches not minted by runs')
    .option('--json', 'write the branch report as JSON')
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
    .description('record the pull request that landed a branch')
    .argument('<branch>')
    .requiredOption('--pr <number>', 'name the merged pull request')
    .option('--json', 'write the landing record as JSON')
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
    .description('delete branches proven safe to reclaim')
    .requiredOption('--project <name>', 'prune branches in this project')
    .option('--key <KEY>', 'prune run-minted branches for this task')
    .option('--all-local', 'prune local branches not minted by runs')
    .option('--dry-run', 'report branches without deleting them')
    .option('--json', 'write the prune report as JSON')
    .allowExcessArguments(false)
    .action((options) => {
      if (Boolean(options.key) === Boolean(options.allLocal)) {
        throw new Error(
          `${PLATFORM_SLUG} tree branch prune requires exactly one of --key <KEY> or --all-local`,
        )
      }
      const report = options.allLocal
        ? pruneOtherBranches({ project: options.project, dryRun: options.dryRun })
        : pruneBranches({ project: options.project, key: options.key, dryRun: options.dryRun })
      log(options.json ? JSON.stringify(report) : renderBranchPruneReport(report))
      if (report.errors.length) process.exitCode = 1
    })
}
