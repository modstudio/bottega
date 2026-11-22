// concern: cli
/** Registers the release adapter. Must not own release policy or persistence. */
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ReleaseAtCommitReport } from '../release/release-at-commit.ts'
import { releaseAtCommit } from '../release/release-at-commit.ts'
import {
  checkRelease,
  type ReleaseResult,
  releaseLog,
  releaseProject,
} from '../release/release-service.ts'
import { log } from './support.ts'

function writeReleaseResult(result: ReleaseResult): void {
  if (result.alreadyLive) {
    log(`${result.project}/${result.rung}: already live at ${result.deployed}; nothing deployed`)
    if (result.landingAhead) {
      log(
        `${result.trunk} has ${result.commitsBehindTrunk} newer commits that are not on ${result.branch}; promote them to ${result.branch} first`,
      )
    }
    if (result.warning) log(`warning: ${result.warning}`)
    return
  }
  if (result.outputTail) log(result.outputTail)
  log(
    `${result.project}/${result.rung}: deployed ${result.deployed}, deploy exit ${result.exitCode}, ledger ${result.id}`,
  )
  if (result.trunk !== result.branch) {
    const detail = `${result.trunk} is ${result.commitsBehindTrunk} commits ahead of ${result.branch}`
    log(result.behindTrunkReason ? `${detail}; override: ${result.behindTrunkReason}` : detail)
  }
  if (result.baseline) log('baseline: no prior live commit was known')
  if (result.rollback) log(`rollback: ${result.rollbackReason}`)
  if (result.warning) log(`warning: ${result.warning}`)
}

type ReleaseOptions = {
  rung?: string
  at?: string
  rollback?: string
  behindTrunk?: string
  redeploy?: string
  json?: boolean
}

async function runRelease(project: string | undefined, options: ReleaseOptions): Promise<void> {
  if (!project)
    throw new Error(
      `${PLATFORM_SLUG} release run <project> [--rung <name>] [--rollback "<reason>"] [--behind-trunk "<reason>"] [--redeploy "<reason>"]`,
    )
  const releaseTree = options.at ? await runReleaseAtCommit(project, options) : undefined
  const result =
    releaseTree?.result ??
    releaseProject(
      project,
      options.rung,
      options.rollback,
      options.behindTrunk,
      options.redeploy,
    )
  writeReleaseOutput(result, releaseTree, Boolean(options.json))
  if (result.exitCode !== 0) process.exitCode = result.exitCode
}

async function runReleaseAtCommit(
  project: string,
  options: ReleaseOptions,
): Promise<ReleaseAtCommitReport> {
  if (!options.at) throw new Error('--at requires a commit')
  if (!options.rung) throw new Error('--at requires --rung')
  if (options.rollback || options.behindTrunk || options.redeploy)
    throw new Error('--at cannot be combined with --rollback, --behind-trunk, or --redeploy')
  return releaseAtCommit({ project, rung: options.rung, commit: options.at })
}

function writeReleaseOutput(
  result: ReleaseResult,
  releaseTree: ReleaseAtCommitReport | undefined,
  json: boolean,
): void {
  if (json) {
    log(
      JSON.stringify(
        releaseTree
          ? {
              ...result,
              releaseTreeTiming: {
                provisionMs: releaseTree.provisionMs,
                deployMs: releaseTree.deployMs,
                releaseMs: releaseTree.releaseMs,
              },
              ...(releaseTree.residue ? { releaseTreeResidue: releaseTree.residue } : {}),
            }
          : result,
      ),
    )
    return
  }
  if (releaseTree) {
    log(
      `release tree timing: provision ${releaseTree.provisionMs}ms, deploy ${releaseTree.deployMs}ms, release ${releaseTree.releaseMs}ms${releaseTree.residue ? `; residue: ${releaseTree.residue}` : ''}`,
    )
  }
  writeReleaseResult(result)
}

export function register(program: Command): void {
  const release = program
    .command('release [project]')
    .description(
      'run the registered deploy with BOTTEGA_RELEASE_PROJECT, BOTTEGA_RELEASE_RUNG, and BOTTEGA_RELEASE_COMMIT set, plus BOTTEGA_RELEASE_ROLLBACK set to 1 on a deliberate rollback; for a rung CI deploys, wait for its live probe to contain the branch tip and record the proof',
    )
    .option('--rung <name>', 'release rung to run')
    .option('--at <commit>', 'provision a detached release tree at this commit')
    .option('--rollback <reason>', 'reason for deploying the prior live commit')
    .option('--behind-trunk <reason>', 'reason for deploying a branch behind the project trunk')
    .option('--redeploy <reason>', 'deploy again even when this commit is already live')
    .option('--json', 'write the release result as JSON')
    .allowExcessArguments(false)
    .action(runRelease)

  release
    .command('check <tag>')
    .description(
      'validate the release tag and prove release binaries ignore working-directory config',
    )
    .allowExcessArguments(false)
    .action(async (tag) => {
      const checked = await checkRelease(tag)
      if (checked.runtimeConfigGuardSkip) log(checked.runtimeConfigGuardSkip)
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
          `${row.number}  ${row.started_at}  ${row.project}/${row.rung}  ${row.candidate_commit}  ${row.exit_code === null ? 'running' : `exit ${row.exit_code}`}${row.rollback ? `  rollback: ${row.rollback_reason}` : ''}${row.warning ? `  warning: ${row.warning}` : ''}`,
        )
      }
    })
}
