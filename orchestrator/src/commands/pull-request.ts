// concern: cli
/** Registers the pull-request admission wrapper and its read-only pre-push check. */
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { writableDb } from '../database/db.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import {
  checkPushedTip,
  createPullRequest,
  recordTriageOverride,
} from '../pull-request/pr-admission.ts'
import type { PullRequestCiCounts } from '../pull-request/pr-ci-record.ts'
import { recordPullRequestCi } from '../pull-request/pr-ci-record.ts'
import { mergePullRequest } from '../pull-request/pr-merge.ts'
import { resolveReviewCommandCwd } from '../review/review-command-cwd.ts'
import { log } from './support.ts'

const forbiddenGithubFlag = (value: string): string | null => {
  const long = ['--head', '--base', '--repo', '--web', '--dry-run', '--recover', '--json']
  const matchedLong = long.find((flag) => value === flag || value.startsWith(`${flag}=`))
  if (matchedLong) return matchedLong
  const short = ['-H', '-B', '-R', '-w']
  return short.find((flag) => value === flag || value.startsWith(flag)) ?? null
}

export function validateGithubArguments(args: readonly string[]): void {
  const forbidden = args.map(forbiddenGithubFlag).find((flag) => flag !== null)
  if (forbidden) {
    throw new Error(
      `${PLATFORM_SLUG} pr create refuses ${forbidden}; it admits the checked-out head into the registered landing branch and owns pull-request output`,
    )
  }
}

export function pullRequestCiCommandOutcome(result: {
  prNumber: number
  complete: boolean
  counts: PullRequestCiCounts
  error?: string
}): { output: string | null; error: string | null; exitCode: number } {
  if (!result.complete) {
    return { output: null, error: result.error ?? 'CI recording incomplete', exitCode: 1 }
  }
  return {
    output: `PR #${result.prNumber}: ${result.counts.ciRuns} CI runs, ${result.counts.reruns} reruns, ${result.counts.flakeAttributedReruns} flake-attributed reruns`,
    error: null,
    exitCode: 0,
  }
}

function createPullRequestCommand(
  githubArgs: string[],
  options: {
    cwd?: string
    overrideTriage?: string
    ceilingRuling?: string
    fromOperator?: boolean
  },
): void {
  validateGithubArguments(githubArgs)
  const result = createPullRequest(
    githubArgs,
    {
      overrideReason: options.overrideTriage,
      ceilingRuling: options.ceilingRuling,
      fromOperator: options.fromOperator,
    },
    resolveReviewCommandCwd(options.cwd),
  )
  if (result.output) log(result.output)
  if (result.overrideId !== null) {
    log(`pull-request triage admitted by recorded ruling ${result.overrideId}`)
  }
}

export function register(program: Command): void {
  const pr = program.command('pr').allowExcessArguments(false)

  pr.command('create [githubArgs...]')
    .description('create a pull request after review-triage admission')
    .allowUnknownOption(true)
    .option('--cwd <tree>', 'verify and create from this worktree')
    .option('--override-triage <reason>', 'admit incomplete review triage for this reason')
    .option('--ceiling-ruling <reason>', 'admit remaining review gaps at the round ceiling')
    .option('--from-operator', 'confirm the override came directly from the operator')
    .action(createPullRequestCommand)

  pr.command('merge <number-or-url>')
    .description('merge a pull request only when its head commit is proven')
    .option('--cwd <tree>', 'verify and merge from this worktree')
    .option('--release-required', 'release every rung required by the merged paths')
    .allowExcessArguments(false)
    .action((target: string, options) => {
      const outcome = mergePullRequest(
        target,
        resolveReviewCommandCwd(options.cwd),
        undefined,
        undefined,
        Boolean(options.releaseRequired),
      )
      log(outcome.output)
      if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode
    })

  pr.command('ci-record <number>')
    .description('record GitHub Actions attempts for an already-merged pull request')
    .option('--project <name>', 'record against this registered project')
    .allowExcessArguments(false)
    .action((target: string, options) => {
      const database = writableDb()
      const project = options.project
        ? projectByName(options.project, database)
        : projectAt(process.cwd(), database)
      if (!project) {
        throw new Error(
          options.project
            ? `no registered project ${options.project}`
            : `cannot resolve a project for ${process.cwd()}; pass --project <name>`,
        )
      }
      const result = recordPullRequestCi({
        project,
        target,
        cwd: project.path,
        database,
      })
      const outcome = pullRequestCiCommandOutcome(result)
      if (outcome.error) console.error(outcome.error)
      if (outcome.output) log(outcome.output)
      if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode
    })

  pr.command('override')
    .description('record an operator override for the checked-out tip')
    .requiredOption('--reason <reason>', 'record why the operator admits incomplete triage')
    .option('--from-operator', 'confirm the override came directly from the operator')
    .allowExcessArguments(false)
    .action((options) => {
      const id = recordTriageOverride(options.reason, Boolean(options.fromOperator), process.cwd())
      log(String(id))
    })

  pr.command('check')
    .description('read-only pre-push triage check')
    .requiredOption('--local-ref <ref>', 'name the local ref being pushed')
    .requiredOption('--sha <sha>', 'name the commit being pushed')
    .requiredOption('--remote-ref <ref>', 'name the destination ref')
    .allowExcessArguments(false)
    .action((options) => {
      const result = checkPushedTip(process.cwd(), options.sha.trim(), options.remoteRef.trim())
      if (result.infrastructureError) {
        log(`pre-push: triage check could not run: ${result.infrastructureError}; allowing push`)
        return
      }
      if (result.refusal) throw new Error(result.refusal)
      if (result.overrideId !== null) {
        log(`triage admitted by recorded ruling ${result.overrideId}`)
      }
      if (result.pendingIntent) {
        log(
          `triage snapshot intent for ${options.remoteRef} is pending pull-request reconciliation`,
        )
      }
      log(
        result.known
          ? `triage complete for ${options.remoteRef} at ${options.sha}`
          : `branch ${options.remoteRef} is not recorded by orch; allowing push`,
      )
    })
}
