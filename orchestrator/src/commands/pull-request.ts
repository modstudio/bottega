// concern: cli
/** Registers the pull-request admission wrapper and its read-only pre-push check. */
import type { Command } from 'commander'
import {
  checkPushedTip,
  createPullRequest,
  recordTriageOverride,
} from '../pull-request/pr-admission.ts'
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
      `orch pr create refuses ${forbidden}; it admits the checked-out head into the registered landing branch and owns pull-request output`,
    )
  }
}

export function register(program: Command): void {
  const pr = program.command('pr').allowExcessArguments(false)

  pr.command('create [githubArgs...]')
    .description('create a pull request after review-triage admission')
    .allowUnknownOption(true)
    .option('--override-triage <reason>')
    .option('--from-operator')
    .action((githubArgs: string[], options) => {
      validateGithubArguments(githubArgs)
      const result = createPullRequest(
        githubArgs,
        { overrideReason: options.overrideTriage, fromOperator: options.fromOperator },
        process.cwd(),
      )
      if (result.output) log(result.output)
      if (result.overrideId !== null) {
        log(`pull-request triage admitted by operator override ${result.overrideId}`)
      }
    })

  pr.command('override')
    .description('record an operator override for the checked-out tip')
    .requiredOption('--reason <reason>')
    .option('--from-operator')
    .allowExcessArguments(false)
    .action((options) => {
      const id = recordTriageOverride(options.reason, Boolean(options.fromOperator), process.cwd())
      log(String(id))
    })

  pr.command('check')
    .description('read-only pre-push triage check')
    .requiredOption('--local-ref <ref>')
    .requiredOption('--sha <sha>')
    .requiredOption('--remote-ref <ref>')
    .allowExcessArguments(false)
    .action((options) => {
      const result = checkPushedTip(process.cwd(), options.sha.trim(), options.remoteRef.trim())
      if (result.infrastructureError) {
        log(`pre-push: triage check could not run: ${result.infrastructureError}; allowing push`)
        return
      }
      if (result.refusal) throw new Error(result.refusal)
      if (result.overrideId !== null) {
        log(`triage admitted by operator override ${result.overrideId}`)
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
