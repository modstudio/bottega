// concern: cli
/** Registers the pull-request admission wrapper and its read-only pre-push check. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Command, Option } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { isStoreFencedAfterCheckoutMove, writableDb } from '../database/db.ts'
import {
  pullRequestMergeContextMomentEffect,
  pullRequestMergeContextTarget,
} from '../doc/context-moment.ts'
import { applyContextMomentEffect } from '../doc/context-moment-adapter.ts'
import { getContext } from '../doc/context-service.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { assertOrchestratorProse } from '../prose-service.ts'
import {
  checkPushedTip,
  createPullRequest,
  recordTriageOverride,
} from '../pull-request/pr-admission.ts'
import type { PullRequestCiCounts } from '../pull-request/pr-ci-record.ts'
import { recordPullRequestCi } from '../pull-request/pr-ci-record.ts'
import { POST_LANDING_REPORTED_EXIT_CODE } from '../pull-request/pr-landed-exit-codes.ts'
import { mergePullRequest, type PullRequestMergeCommandOutcome } from '../pull-request/pr-merge.ts'
import { runPullRequestPostLanding } from '../pull-request/pr-post-landing.ts'
import {
  POST_LANDING_FLAG,
  type PullRequestPostLandingPayload,
  parsePullRequestPostLandingPayload,
  postLandingRecovery,
} from '../pull-request/pr-post-landing-payload.ts'
import { resolveReviewCommandCwd } from '../review/review-command-cwd.ts'
import { log } from './support.ts'

export const PR_CREATE_OPTIONS = [
  { flags: '--cwd <tree>', description: 'verify and create from this worktree' },
  {
    flags: '--override-triage <reason>',
    description: 'admit incomplete review triage for this reason',
  },
  {
    flags: '--ceiling-ruling <reason>',
    description: 'admit remaining review gaps at the round ceiling',
  },
  { flags: '--from-operator', description: 'confirm the override came directly from the operator' },
] as const

export const PR_MERGE_OPTIONS = [
  { flags: '--cwd <tree>', description: 'verify and merge from this worktree' },
  {
    flags: '--release-required',
    description: 'release every rung required by the merged paths',
  },
  { flags: '--depth <rung>', description: 'bound the production release reach through this rung' },
] as const

function addPullRequestOptions(
  command: Command,
  options: readonly { flags: string; description: string }[],
): Command {
  for (const option of options) command.option(option.flags, option.description)
  return command
}

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

function githubValue(args: string[], long: string, short: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === long || argument === short) return args[index + 1]
    if (argument.startsWith(`${long}=`)) return argument.slice(long.length + 1)
  }
  return undefined
}

export function githubArgsWithStdinBody(args: readonly string[], body: string): string[] {
  const rewritten: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if ((argument === '--body-file' || argument === '-F') && args[index + 1] === '-') {
      rewritten.push('--body', body)
      index += 1
    } else if (argument === '--body-file=-') {
      rewritten.push('--body', body)
    } else {
      rewritten.push(argument)
    }
  }
  return rewritten
}

export async function createPullRequestCommand(
  githubArgs: string[],
  options: {
    cwd?: string
    overrideTriage?: string
    ceilingRuling?: string
    fromOperator?: boolean
  },
  _command?: Command,
  create: typeof createPullRequest = createPullRequest,
): Promise<void> {
  validateGithubArguments(githubArgs)
  const cwd = resolveReviewCommandCwd(options.cwd)
  const title = githubValue(githubArgs, '--title', '-t')
  const inlineBody = githubValue(githubArgs, '--body', '-b')
  const bodyFile = githubValue(githubArgs, '--body-file', '-F')
  // gh resolves a relative body file against its own cwd, so read it from there.
  const body = bodyFile
    ? bodyFile === '-'
      ? await Bun.stdin.text()
      : readFileSync(resolve(cwd, bodyFile), 'utf8')
    : inlineBody
  // Text derived from commits is covered by the commit-msg prose hook.
  await assertOrchestratorProse([
    { field: 'title', text: title ?? '', prior: null },
    { field: 'body', text: body ?? '', prior: null },
  ])
  const forwardedArgs =
    bodyFile === '-' ? githubArgsWithStdinBody(githubArgs, body ?? '') : githubArgs
  const result = create(
    forwardedArgs,
    {
      overrideReason: options.overrideTriage,
      ceilingRuling: options.ceilingRuling,
      fromOperator: options.fromOperator,
    },
    cwd,
  )
  if (result.output) log(result.output)
  if (result.overrideId !== null) {
    log(`pull-request triage admitted by recorded ruling ${result.overrideId}`)
  }
}

type PullRequestContextMomentInput = Pick<
  PullRequestMergeCommandOutcome,
  'exitCode' | 'headBranch' | 'pullRequestNumber' | 'mergeCommit'
>

type PullRequestContextMomentPorts = {
  getContext: typeof getContext
  applyEffect: typeof applyContextMomentEffect
  storeFenced: typeof isStoreFencedAfterCheckoutMove
  log: typeof log
  error: typeof console.error
}

const pullRequestContextMomentPorts: PullRequestContextMomentPorts = {
  getContext,
  applyEffect: applyContextMomentEffect,
  storeFenced: isStoreFencedAfterCheckoutMove,
  log,
  error: console.error,
}

async function applyPullRequestContextMoment(
  keyPrefixes: readonly string[],
  outcome: PullRequestContextMomentInput,
  overrides: Partial<PullRequestContextMomentPorts> = {},
): Promise<void> {
  const ports = { ...pullRequestContextMomentPorts, ...overrides }
  const taskKey = pullRequestMergeContextTarget({
    exitCode: outcome.exitCode,
    headBranch: outcome.headBranch,
    keyPrefixes,
  })
  if (!taskKey) return
  try {
    const context = await ports.getContext({ task: taskKey })
    const effect = pullRequestMergeContextMomentEffect({
      pullRequestNumber: outcome.pullRequestNumber,
      mergeCommit: outcome.mergeCommit,
      items: context.items,
    })
    await ports.applyEffect(taskKey, effect, false, { log: ports.log, error: ports.error })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    ports.log(`context: could not gather pr-merge on ${taskKey}: ${detail}`)
  }
}

export async function applyParentPullRequestContextMoment(
  keyPrefixes: readonly string[],
  outcome: PullRequestContextMomentInput,
  overrides: Partial<PullRequestContextMomentPorts> = {},
): Promise<void> {
  const ports = { ...pullRequestContextMomentPorts, ...overrides }
  if (ports.storeFenced()) return
  await applyPullRequestContextMoment(keyPrefixes, outcome, ports)
}

type PullRequestPostLandingCommandPorts = PullRequestContextMomentPorts & {
  readPayload: () => Promise<string>
  runPostLanding: typeof runPullRequestPostLanding
  projectByName: typeof projectByName
}

const pullRequestPostLandingCommandPorts: PullRequestPostLandingCommandPorts = {
  ...pullRequestContextMomentPorts,
  readPayload: () => Bun.stdin.text(),
  runPostLanding: runPullRequestPostLanding,
  projectByName,
}

export async function runPullRequestPostLandingCommand(
  target: string,
  database: ReturnType<typeof writableDb>,
  overrides: Partial<PullRequestPostLandingCommandPorts> = {},
): Promise<number> {
  const ports = { ...pullRequestPostLandingCommandPorts, ...overrides }
  let recoveryDepth: string | null = null
  let payload: PullRequestPostLandingPayload | null = null
  let exitCode = 0
  try {
    payload = parsePullRequestPostLandingPayload(await ports.readPayload())
    recoveryDepth = payload.depth
    if (payload.target !== target)
      throw new Error('post-landing payload target does not match the command target')
    const outcome = await ports.runPostLanding(payload, database)
    ports.log(outcome.output)
    exitCode = outcome.exitCode
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    ports.log(
      `post-landing steps did not complete: ${detail}; ${postLandingRecovery(target, recoveryDepth)}`,
    )
    exitCode = POST_LANDING_REPORTED_EXIT_CODE
  }
  if (payload) {
    let project: ReturnType<typeof projectByName> = null
    try {
      project = ports.projectByName(payload.project, database)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      ports.log(`context: could not resolve project ${payload.project} for pr-merge: ${detail}`)
      return exitCode
    }
    await applyPullRequestContextMoment(
      project?.settings.keyPrefixes ?? [],
      {
        exitCode,
        headBranch: payload.headBranch,
        pullRequestNumber: payload.prNumber,
        mergeCommit: payload.mergeCommit,
      },
      ports,
    )
  }
  return exitCode
}

export async function mergePullRequestCommand(
  target: string,
  options: { cwd?: string; releaseRequired?: boolean; postLanding?: boolean; depth?: string },
): Promise<void> {
  if (options.postLanding) {
    const exitCode = await runPullRequestPostLandingCommand(target, writableDb())
    if (exitCode !== 0) process.exitCode = exitCode
    return
  }
  const cwd = resolveReviewCommandCwd(options.cwd)
  const database = writableDb()
  const project = projectAt(cwd, database)
  const outcome = await mergePullRequest(
    target,
    cwd,
    undefined,
    undefined,
    Boolean(options.releaseRequired),
    options.depth,
  )
  log(outcome.output)
  if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode
  await applyParentPullRequestContextMoment(project?.settings.keyPrefixes ?? [], outcome)
}

export function register(program: Command): void {
  const pr = program.command('pr').allowExcessArguments(false)

  addPullRequestOptions(
    pr
      .command('create [githubArgs...]')
      .description('create a pull request after review-triage admission')
      .allowUnknownOption(true),
    PR_CREATE_OPTIONS,
  )
    .action(createPullRequestCommand)

  addPullRequestOptions(
    pr
      .command('merge <number-or-url>')
      .description('merge a pull request only when its head commit is proven'),
    PR_MERGE_OPTIONS,
  )
    .addOption(new Option(POST_LANDING_FLAG, 'complete a moved checkout hand-off').hideHelp())
    .allowExcessArguments(false)
    .action(mergePullRequestCommand)

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
