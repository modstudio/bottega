// concern: release-required
/** Decides and runs release rungs made mandatory by the merged change. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { git, gitResult, targetGitEnvironment } from '../git/git-environment.ts'
import { returnMainCheckoutToTrunkCommand } from '../project/main-checkout-invariant.ts'
import type { Project } from '../project/projects.ts'
import { declaredGlobsMatch } from '../review/review-declared-globs.ts'
import { releaseProofDecision, releaseRungProofRefusal } from './release-decision.ts'
import type { EntryClosure } from './release-entry-closure.ts'
import {
  newestSuccessfulProvenReleaseCommit,
  type ReleaseResult,
  releaseProject,
} from './release-service.ts'
import { decideShipToReach, releaseDepthFlag, shipToRungs } from './ship-to-reach.ts'
import { releaseAtCommit } from './release-at-commit.ts'

export type RequiredReleaseRung = {
  name: string
  branch: string
  deploy?: string
  preflight?: string
  onDemand?: boolean
  live?: string
  liveVersion?: { command: string; file: string; key: string }
  requiredWhenChanged?: readonly string[]
  releasesWhenChanged?: readonly string[]
  entryPoints?: readonly string[]
}

export function decideRequiredRungs(
  rungs: readonly RequiredReleaseRung[],
  changedPaths: readonly string[],
  entryClosure: EntryClosure,
): string[] {
  return rungs
    .filter(
      (rung) =>
        declaredGlobsMatch(changedPaths, rung.requiredWhenChanged ?? []) ||
        (rung.entryPoints ?? []).some((entry) =>
          changedPaths.some((path) => entryClosure.get(entry)?.has(path)),
        ),
    )
    .map((rung) => rung.name)
}

type RequiredRungRelease = {
  rung: string
  required?: boolean
  deployExit: number | null
  outputTail: string
  satisfied: boolean
  deployed: boolean
  unprovable?: true
}

export type RequiredReleaseReport = {
  required: string[]
  releases: RequiredRungRelease[]
  satisfied: boolean
  decisionError?: string
}

export type ReleaseRungPlan = {
  rung: string
  branch: string
  required: boolean
  requiredBy: (typeof RELEASE_REQUIREMENT_SOURCES)[number] | null
  reason: string | null
  declaresLive: boolean
  declaresDeploy: boolean
}

export const RELEASE_REQUIREMENT_SOURCES = ['explicit', 'reach'] as const

export type RequiredRungDecision =
  | { decided: true; required: string[]; rungs: ReleaseRungPlan[]; error: null }
  | { decided: false; required: string[]; rungs: ReleaseRungPlan[]; error: string }

export type RequiredReleaseStep = 'deploy-rungs' | 'move-main' | 'hand-off'

/** Decide the only allowed ordering before adapters perform any side effect. */
export function requiredReleaseStepOrder(
  releaseRequired: boolean,
  plans: readonly Pick<ReleaseRungPlan, 'required'>[],
): RequiredReleaseStep[] {
  return releaseRequired && plans.some(({ required }) => required)
    ? ['deploy-rungs', 'move-main', 'hand-off']
    : ['move-main', 'hand-off']
}

export function machineUpdateRungRefusal(input: {
  incomingCommit: string
  requiredRungs: readonly string[]
  provedCommits: ReadonlyMap<string, string | null>
  liveContainsIncoming: ReadonlyMap<string, boolean>
  project: string
}): string | null {
  for (const rung of input.requiredRungs) {
    const proved = input.provedCommits.get(rung) ?? null
    if (proved && input.liveContainsIncoming.get(rung)) continue
    return (
      `refusing machine update: required rung ${rung} has not proved incoming commit ${input.incomingCommit} live; ` +
      `run ${PLATFORM_SLUG} release run ${input.project} --rung ${rung} --at ${input.incomingCommit}, then retry ${PLATFORM_SLUG} machine update`
    )
  }
  return null
}

function notRequiredReason(
  rung: RequiredReleaseRung,
  depth: string | undefined,
  skipped: ReadonlyMap<string, string>,
  beyondDepth: ReadonlySet<string>,
): string {
  const skippedReason = skipped.get(rung.name)
  if (skippedReason) return skippedReason
  if (beyondDepth.has(rung.name)) return `beyond depth ${depth}`
  if (rung.onDemand && rung.requiredWhenChanged !== undefined)
    return 'no changed path matches requiredWhenChanged'
  return `on demand: no requiredWhenChanged or entry point matched; release with \`${PLATFORM_SLUG} release run <project> --rung ${rung.name}\``
}

function releaseRungPlans(
  rungs: readonly RequiredReleaseRung[],
  explicitlyRequired: ReadonlySet<string>,
  reached: ReadonlySet<string>,
  depth: string | undefined,
  skipped: ReadonlyMap<string, string>,
  beyondDepth: ReadonlySet<string>,
  landingBranch: string,
): ReleaseRungPlan[] {
  return rungs.map((rung) => {
    const requiredBy = explicitlyRequired.has(rung.name)
      ? 'explicit'
      : reached.has(rung.name)
        ? 'reach'
        : null
    const required = requiredBy !== null && rung.branch === landingBranch
    return {
      rung: rung.name,
      branch: rung.branch,
      required,
      requiredBy,
      reason:
        requiredBy !== null && !required
          ? `proved at promote-release: rung ${rung.name} deploys from ${rung.branch}, not the landing branch ${landingBranch}`
          : requiredBy !== null
            ? null
            : notRequiredReason(rung, depth, skipped, beyondDepth),
      declaresLive: rung.live !== undefined || rung.liveVersion !== undefined,
      declaresDeploy: rung.deploy !== undefined,
    }
  })
}

export function legacyRungPlans(
  rungs: readonly RequiredReleaseRung[],
  requiredRungs: readonly string[],
  landingBranch: string,
): ReleaseRungPlan[] {
  const known = new Set(rungs.map(({ name }) => name))
  const allRungs = [
    ...rungs,
    ...requiredRungs
      .filter((name) => !known.has(name))
      .map((name) => ({ name, branch: landingBranch })),
  ]
  return releaseRungPlans(
    allRungs,
    new Set(requiredRungs),
    new Set(),
    undefined,
    new Map(),
    new Set(),
    landingBranch,
  )
}

/** Own the required-rung policy, including a failure to inspect the landed paths. */
export function requiredRungDecision(
  project: Project,
  readChangedPaths: () => readonly string[],
  readEntryClosure: (entries: readonly string[]) => EntryClosure,
  depth?: string,
): RequiredRungDecision {
  const rungs = project.settings.release?.rungs ?? []
  if (rungs.length === 0) return { decided: true, required: [], rungs: [], error: null }
  try {
    const changedPaths = readChangedPaths()
    const entries = [...new Set(rungs.flatMap((rung) => rung.entryPoints ?? []))]
    const entryClosure = entries.length > 0 ? readEntryClosure(entries) : new Map()
    const explicitlyRequired = new Set(decideRequiredRungs(rungs, changedPaths, entryClosure))
    const reach = decideShipToReach('production', shipToRungs(rungs), depth, { changedPaths })
    if (!reach.allowed) throw new Error(reach.refusal)
    const reached = new Set(reach.reach)
    const skipped = new Map(reach.skipped.map(({ name, reason }) => [name, reason]))
    const beyondDepth = new Set(reach.remaining)
    const plans = releaseRungPlans(
      rungs,
      explicitlyRequired,
      reached,
      depth,
      skipped,
      beyondDepth,
      project.settings.trunk!,
    )
    return {
      decided: true,
      required: plans.filter(({ required }) => required).map(({ rung }) => rung),
      rungs: plans,
      error: null,
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause)
    const plans = rungs.map(
      (rung): ReleaseRungPlan => ({
        rung: rung.name,
        branch: rung.branch,
        required: false,
        requiredBy: null,
        reason: `requirement could not be decided: ${error}`,
        declaresLive: rung.live !== undefined || rung.liveVersion !== undefined,
        declaresDeploy: rung.deploy !== undefined,
      }),
    )
    return {
      decided: false,
      required: [],
      rungs: plans,
      error,
    }
  }
}

export type RequiredReleaseRunner = {
  newestLive(project: Project, rung: string): string | null
  contains(project: Project, ancestor: string, descendant: string): boolean
  release(project: Project, rung: string): ReleaseResult
}

const requiredReleaseRunner: RequiredReleaseRunner = {
  newestLive(project, rung) {
    return newestSuccessfulProvenReleaseCommit(project.name, rung)
  },
  contains(project, ancestor, descendant) {
    return gitResult(['merge-base', '--is-ancestor', ancestor, descendant], project.path).ok
  },
  release(project, rung) {
    return releaseProject(project.name, rung, undefined, undefined)
  },
}

export function verifyMainCheckout(project: Project, mergeCommit?: string): void {
  const trunk = project.settings.trunk
  if (!trunk) throw new Error('project has no trunk; set trunk, then retry')
  const branch = git(
    ['branch', '--show-current'],
    project.path,
    targetGitEnvironment(project.path),
    ' during main checkout branch lookup',
  )
  if (branch !== trunk) {
    throw new Error(
      `registered main checkout is on ${branch || 'detached HEAD'}, not ${trunk}; run ${returnMainCheckoutToTrunkCommand(project.path, trunk)}, then retry`,
    )
  }
  const dirty = git(
    ['status', '--porcelain'],
    project.path,
    targetGitEnvironment(project.path),
    ' during main checkout status',
  )
  if (dirty) throw new Error('registered main checkout is dirty; clean it')
  if (mergeCommit) {
    const ancestry = gitResult(['merge-base', '--is-ancestor', mergeCommit, 'HEAD'], project.path, {
      env: targetGitEnvironment(project.path),
    })
    if (!ancestry.ok) {
      if (ancestry.stderr === 'exit 1')
        throw new Error(`registered main checkout does not contain landing commit ${mergeCommit}`)
      throw new Error(
        `registered main checkout landing-commit check could not run for ${mergeCommit}: ${ancestry.stderr}`,
      )
    }
  }
}

export function mainCheckoutHead(project: Project): string {
  return git(
    ['rev-parse', 'HEAD'],
    project.path,
    targetGitEnvironment(project.path),
    ' during main checkout HEAD lookup',
  )
}

/** Move a registered main checkout whose code is not the running Bottega installation. */
export function moveNonInstallationMainCheckout(project: Project, mergeCommit?: string): void {
  verifyMainCheckout(project)
  const trunk = project.settings.trunk!
  git(
    ['fetch', 'origin', trunk],
    project.path,
    targetGitEnvironment(project.path),
    ' during main checkout fetch',
  )
  git(
    ['merge', '--ff-only', `origin/${trunk}`],
    project.path,
    targetGitEnvironment(project.path),
    ' during main checkout fast-forward',
  )
  if (mergeCommit) verifyMainCheckout(project, mergeCommit)
}

export function changedPaths(project: Project, mergeCommit: string): string[] {
  const trunk = project.settings.trunk
  if (!trunk) throw new Error('project has no trunk; set trunk, then retry')
  git(
    ['fetch', 'origin', trunk],
    project.path,
    targetGitEnvironment(project.path),
    ' during landing-branch fetch',
  )
  return splitNulPaths(
    git(
      nulPathListArgs(['diff', '--name-only', `${mergeCommit}^1`, mergeCommit]),
      project.path,
      targetGitEnvironment(project.path),
      ' during merge first-parent diff',
    ),
  )
}

function failure(plan: ReleaseRungPlan, detail: string): RequiredRungRelease {
  return {
    rung: plan.rung,
    required: plan.required,
    deployExit: null,
    outputTail: plan.required ? detail : (plan.reason ?? detail),
    satisfied: !plan.required,
    deployed: false,
  }
}

export function failedRequiredRelease(
  rungs: ReleaseRungPlan[],
  detail: string,
): RequiredReleaseReport {
  return {
    required: rungs.filter(({ required }) => required).map(({ rung }) => rung),
    releases: rungs.map((rung) => failure(rung, detail)),
    satisfied: rungs.every(({ required }) => !required),
  }
}

export function undecidedRequiredRelease(
  rungs: ReleaseRungPlan[],
  error: string,
): RequiredReleaseReport {
  return {
    required: [],
    releases: rungs.map((rung) => ({
      rung: rung.rung,
      required: false,
      deployExit: null,
      outputTail: rung.reason ?? 'requirement could not be decided',
      satisfied: false,
      deployed: false,
    })),
    satisfied: false,
    decisionError: error,
  }
}

export function releaseRequiredFlagAbsent(rungs: ReleaseRungPlan[]): RequiredReleaseReport {
  const releases = rungs.map((plan): RequiredRungRelease => {
    if (!plan.required) return failure(plan, plan.reason ?? 'not required')
    if (plan.requiredBy !== 'reach')
      return failure(plan, 'not released because --release-required was absent')
    return failure(
      { ...plan, required: false },
      'ship-to reach deploys only at production with --release-required',
    )
  })
  return {
    required: rungs
      .filter(({ required, requiredBy }) => required && requiredBy !== 'reach')
      .map(({ rung }) => rung),
    releases,
    satisfied: releases.every(({ satisfied }) => satisfied),
  }
}

export function releaseRequiredRungsAfterMainMove(input: {
  project: Project
  mergeCommit: string
  rungs: ReleaseRungPlan[]
  runner?: RequiredReleaseRunner
}): RequiredReleaseReport {
  const runner = input.runner ?? requiredReleaseRunner
  return runRequiredReleaseRungs(input.project, input.mergeCommit, input.rungs, runner)
}

/** Release required rungs from lifecycle-backed trees before the registered checkout moves. */
export async function releaseRequiredRungsBeforeMainMove(input: {
  project: Project
  mergeCommit: string
  rungs: ReleaseRungPlan[]
}): Promise<RequiredReleaseReport> {
  const required = input.rungs.filter(({ required }) => required).map(({ rung }) => rung)
  const releases: RequiredRungRelease[] = []
  for (const plan of input.rungs) {
    if (!plan.required) {
      releases.push(failure(plan, plan.reason ?? 'not required'))
      continue
    }
    const proofRefusal = releaseRungProofRefusal(
      PLATFORM_SLUG,
      input.project.name,
      plan.rung,
      plan.branch,
      input.project.settings.release?.rungs ?? [],
    )
    if (proofRefusal) {
      releases.push({ ...failure(plan, proofRefusal), unprovable: true })
      continue
    }
    try {
      const report = await releaseAtCommit({
        project: input.project,
        rung: plan.rung,
        commit: input.mergeCommit,
      })
      const satisfied = releaseProofDecision({
        exitCode: report.result.exitCode,
        liveMatchesCandidate: report.result.liveMatchesCandidate,
        candidateContainsMerge: true,
      })
      const timing = `provision ${report.provisionMs}ms, deploy ${report.deployMs}ms, release ${report.releaseMs}ms`
      releases.push({
        rung: plan.rung,
        required: true,
        deployExit: report.result.exitCode,
        outputTail: satisfied
          ? `rung ${plan.rung} healthy at ${input.mergeCommit} ${new Date().toISOString()} (${timing})`
          : `${report.result.outputTail || '(no deploy output)'} (${timing})`,
        satisfied,
        deployed: !report.result.alreadyLive,
      })
    } catch (cause) {
      releases.push(failure(plan, cause instanceof Error ? cause.message : String(cause)))
    }
  }
  return { required, releases, satisfied: releases.every(({ satisfied }) => satisfied) }
}

function runRequiredReleaseRungs(
  project: Project,
  mergeCommit: string,
  plans: ReleaseRungPlan[],
  runner: RequiredReleaseRunner,
): RequiredReleaseReport {
  const required = plans.filter(({ required }) => required).map(({ rung }) => rung)
  if (plans.length === 0) return { required, releases: [], satisfied: true }
  if (required.length === 0) {
    return {
      required,
      releases: plans.map((plan) => failure(plan, plan.reason ?? 'not required')),
      satisfied: true,
    }
  }
  const releases = plans.map((plan): RequiredRungRelease => {
    if (!plan.required) return failure(plan, plan.reason ?? 'not required')
    const proofRefusal = releaseRungProofRefusal(
      PLATFORM_SLUG,
      project.name,
      plan.rung,
      plan.branch,
      project.settings.release?.rungs ?? [],
    )
    if (proofRefusal) {
      return {
        ...failure(plan, proofRefusal),
        unprovable: true,
      }
    }
    try {
      const live = runner.newestLive(project, plan.rung)
      if (live && runner.contains(project, mergeCommit, live)) {
        return {
          rung: plan.rung,
          required: true,
          deployExit: 0,
          outputTail: `already live at ${live}`,
          satisfied: true,
          deployed: false,
        }
      }
      const result = runner.release(project, plan.rung)
      return {
        rung: plan.rung,
        required: true,
        deployExit: result.exitCode,
        outputTail: result.outputTail || result.warning || '(no deploy output)',
        satisfied: releaseProofDecision({
          exitCode: result.exitCode,
          liveMatchesCandidate: result.liveMatchesCandidate,
          candidateContainsMerge: true,
        }),
        deployed: !result.alreadyLive,
      }
    } catch (cause) {
      return failure(plan, cause instanceof Error ? cause.message : String(cause))
    }
  })
  return { required, releases, satisfied: releases.every((release) => release.satisfied) }
}

export function formatRequiredReleaseReport(
  report: RequiredReleaseReport,
  target: string,
  project: string,
  depth?: string,
): string {
  if (report.decisionError) {
    return `release not proven: requirement could not be decided: ${report.decisionError}; retry: ${PLATFORM_SLUG} pr merge ${target} --release-required${releaseDepthFlag(depth)}`
  }
  if (report.releases.length === 0) return ''
  const lines = report.releases.map((release) =>
    (release.required ?? report.required.includes(release.rung))
      ? `required rung ${release.rung}: deploy exit ${release.deployExit ?? 'not run'}; ${release.outputTail || '(no output)'}`
      : `rung ${release.rung}: not required; ${(release.outputTail || '(no reason)').replace('<project>', project)}`,
  )
  if (!report.satisfied) {
    const rung = report.releases.find((release) => !release.satisfied && !release.unprovable)?.rung
    if (!rung) return lines.join('\n')
    lines.push(
      `remedy: ${PLATFORM_SLUG} pr merge ${target} --release-required${releaseDepthFlag(depth)}, or ${PLATFORM_SLUG} release run ${project} --rung ${rung} and then ${PLATFORM_SLUG} pr merge ${target} --release-required${releaseDepthFlag(depth)}`,
    )
  }
  return lines.join('\n')
}
