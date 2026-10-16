// concern: cli
/** Registers the release adapter. Must not own release policy or persistence. */
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  releaseLog,
  releaseProject,
  validateReleaseTagVersion,
} from '../release/release-service.ts'
import { log } from './support.ts'

export function register(program: Command): void {
  const release = program
    .command('release [project]')
    .description(
      'run the registered deploy with ORCH_RELEASE_PROJECT, ORCH_RELEASE_RUNG, and ORCH_RELEASE_COMMIT set, plus ORCH_RELEASE_ROLLBACK set to 1 on a deliberate rollback',
    )
    .option('--rung <name>', 'release rung to run')
    .option('--rollback <reason>', 'reason for deploying the prior live commit')
    .option('--json', 'write the release result as JSON')
    .allowExcessArguments(false)
    .action((project, options) => {
      if (!project)
        throw new Error(
          `${PLATFORM_SLUG} release run <project> [--rung <name>] [--rollback "<reason>"]`,
        )
      const result = releaseProject(project, options.rung, options.rollback)
      if (options.json) log(JSON.stringify(result))
      else {
        if (result.outputTail) log(result.outputTail)
        log(
          `${result.project}/${result.rung}: candidate ${result.candidate}, deploy exit ${result.exitCode}, ledger ${result.id}`,
        )
        if (result.baseline) log('baseline: no prior live commit was known')
        if (result.rollback) log(`rollback: ${options.rollback}`)
        if (result.warning) log(`warning: ${result.warning}`)
      }
      if (result.exitCode !== 0) process.exitCode = result.exitCode
    })

  release
    .command('check <tag>')
    .description('validate the reported version before tagging a release')
    .allowExcessArguments(false)
    .action((tag) => {
      const checked = validateReleaseTagVersion(tag)
      log(`reported version ${checked.reportedVersion} matches release tag ${checked.tag}`)
    })

  release
    .command('log <project>')
    .description('list recorded releases for a project')
    .option('--rung <name>', 'release rung to include')
    .option('--json', 'write the release entries as JSON')
    .allowExcessArguments(false)
    .action((project, options) => {
      const rows = releaseLog(project, options.rung)
      if (options.json) {
        log(JSON.stringify(rows))
        return
      }
      if (!rows.length) {
        log(`no release entries for ${project}${options.rung ? `/${options.rung}` : ''}`)
        return
      }
      for (const row of rows) {
        log(
          `${row.id}  ${row.started_at}  ${row.project}/${row.rung}  ${row.candidate_commit}  ${row.exit_code === null ? 'running' : `exit ${row.exit_code}`}${row.rollback ? `  rollback: ${row.rollback_reason}` : ''}${row.warning ? `  warning: ${row.warning}` : ''}`,
        )
      }
    })
}
