// concern: cli
/** Registers the release adapter. Must not own release policy or persistence. */
import type { Command } from 'commander'
import {
  releaseLog,
  releaseProject,
  validateReleaseTagVersion,
} from '../release/release-service.ts'
import { log } from './support.ts'

export function register(program: Command): void {
  const release = program
    .command('release [project]')
    .option('--rung <name>')
    .option('--rollback <reason>')
    .option('--json')
    .allowExcessArguments(false)
    .action((project, options) => {
      if (!project)
        throw new Error('orch release <project> [--rung <name>] [--rollback "<reason>"]')
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
    .option('--rung <name>')
    .option('--json')
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
