// concern: release-required
/** Decides and runs release rungs made mandatory by the merged change. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { git, gitResult, targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { declaredGlobsMatch } from '../review/review-declared-globs.ts'
import { releaseProofDecision } from './release-decision.ts'
import { type EntryClosure, entryClosureAtCommit } from './release-entry-closure.ts'
import {
  newestSuccessfulProvenReleaseCommit,
  type ReleaseResult,
  releaseProject,
} from './release-service.ts'
import { decideShipToReach, releaseDepthFlag, shipToRungs } from './ship-to-reach.ts'

export type RequiredReleaseRung = {
  name: string
  onDemand?: boolean
  live?: string
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
}

export type RequiredReleaseReport = {
  required: string[]
  releases: RequiredRungRelease[]
  satisfied: boolean
}

export type ReleaseRungPlan = {
  rung: string
  required: boolean
  requiredBy: (typeof RELEASE_REQUIREMENT_SOURCES)[number] | null
  reason: string | null
  declaresLive: boolean
}

export const RELEASE_REQUIREMENT_SOURCES = ['explicit', 'reach'] as const

export type RequiredRungDecision =
  | { decided: true; required: string[]; rungs: ReleaseRungPlan[]; error: null }
  | { decided: false; required: string[]; rungs: ReleaseRungPlan[]; error: string }

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
): ReleaseRungPlan[] {
  return rungs.map((rung) => {
    const requiredBy = explicitlyRequired.has(rung.name)
      ? 'explicit'
      : reached.has(rung.name)
        ? 'reach'
        : null
    return {
      rung: rung.name,
      required: requiredBy !== null,
      requiredBy,
      reason: requiredBy !== null ? null : notRequiredReason(rung, depth, skipped, beyondDepth),
      declaresLive: rung.live !== undefined,
    }
  })
}

export function legacyRungPlans(
  rungs: readonly RequiredReleaseRung[],
  requiredRungs: readonly string[],
): ReleaseRungPlan[] {
  const known = new Set(rungs.map(({ name }) => name))
  const allRungs = [
    ...rungs,
    ...requiredRungs.filter((name) => !known.has(name)).map((name) => ({ name })),
  ]
  return releaseRungPlans(
    allRungs,
    new Set(requiredRungs),
    new Set(),
    undefined,
    new Map(),
    new Set(),
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
    const required = new Set([...explicitlyRequired, ...reached])
    const skipped = new Map(reach.skipped.map(({ name, reason }) => [name, reason]))
    const beyondDepth = new Set(reach.remaining)
    return {
      decided: true,
      required: rungs.filter(({ name }) => required.has(name)).map(({ name }) => name),
      rungs: releaseRungPlans(rungs, explicitlyRequired, reached, depth, skipped, beyondDepth),
      error: null,
    }
  } catch (cause) {
    const explicitlyRequired = new Set(
      rungs
        .filter((rung) => rung.requiredWhenChanged !== undefined || rung.entryPoints !== undefined)
        .map(({ name }) => name),
    )
    const reached = new Set(
      rungs
        .filter((rung) => !rung.onDemand && !explicitlyRequired.has(rung.name))
        .map(({ name }) => name),
    )
    const required = new Set([...explicitlyRequired, ...reached])
    return {
      decided: false,
      required: rungs.filter(({ name }) => required.has(name)).map(({ name }) => name),
      rungs: releaseRungPlans(rungs, explicitlyRequired, reached, depth, new Map(), new Set()),
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

export type RequiredReleaseRunner = {
  changedPaths(project: Project, mergeCommit: string): string[]
  entryClosure(project: Project, mergeCommit: string, entries: readonly string[]): EntryClosure
  prepareMain(project: Project): void
  newestLive(project: Project, rung: string, declaresLive: boolean): string | null
  contains(project: Project, ancestor: string, descendant: string): boolean
  release(project: Project, rung: string): ReleaseResult
}

const requiredReleaseRunner: RequiredReleaseRunner = {
  changedPaths,
  entryClosure: entryClosureAtCommit,
  prepareMain(project) {
    verifyMainCheckout(project)
  },
  newestLive(project, rung, declaresLive) {
    return newestSuccessfulProvenReleaseCommit(project.name, rung, declaresLive)
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
      `registered main checkout is on ${branch || 'detached HEAD'}, not ${trunk}; switch it to ${trunk}`,
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

export function releaseRequiredFlagAbsent(
  rungs: ReleaseRungPlan[],
  decisionError?: string | null,
): RequiredReleaseReport {
  const withDecisionError = (detail: string): string =>
    decisionError ? `${detail}; ${decisionError}` : detail
  const releases = rungs.map((plan): RequiredRungRelease => {
    if (plan.requiredBy !== 'reach')
      return failure(plan, withDecisionError('not released because --release-required was absent'))
    return failure(
      { ...plan, required: false },
      withDecisionError('ship-to reach deploys only at production with --release-required'),
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
  return runRequiredReleaseRungs(input.project, input.mergeCommit, input.rungs, runner, false)
}

function runRequiredReleaseRungs(
  project: Project,
  mergeCommit: string,
  plans: ReleaseRungPlan[],
  runner: RequiredReleaseRunner,
  prepareMain: boolean,
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
  if (prepareMain) {
    try {
      runner.prepareMain(project)
    } catch (cause) {
      return failedRequiredRelease(plans, cause instanceof Error ? cause.message : String(cause))
    }
  }
  const releases = plans.map((plan): RequiredRungRelease => {
    if (!plan.required) return failure(plan, plan.reason ?? 'not required')
    try {
      const live = runner.newestLive(project, plan.rung, plan.declaresLive)
      if (live && runner.contains(project, mergeCommit, live)) {
        return {
          rung: plan.rung,
          required: true,
          deployExit: 0,
          outputTail: plan.declaresLive ? `already live at ${live}` : `deployed at ${live}`,
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
          declaresLive: plan.declaresLive,
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

export function releaseRequiredRungs(input: {
  project: Project
  mergeCommit: string
  releaseRequired: boolean
  depth?: string
  decision?: RequiredRungDecision
  runner?: RequiredReleaseRunner
}): RequiredReleaseReport {
  const runner = input.runner ?? requiredReleaseRunner
  const decision =
    input.decision ??
    requiredRungDecision(
      input.project,
      () => runner.changedPaths(input.project, input.mergeCommit),
      (entries) => runner.entryClosure(input.project, input.mergeCommit, entries),
      input.depth,
    )
  if (!input.releaseRequired)
    return releaseRequiredFlagAbsent(decision.rungs, decision.decided ? null : decision.error)
  if (!decision.decided) return failedRequiredRelease(decision.rungs, decision.error)
  return runRequiredReleaseRungs(input.project, input.mergeCommit, decision.rungs, runner, true)
}

export function formatRequiredReleaseReport(
  report: RequiredReleaseReport,
  target: string,
  project: string,
  depth?: string,
): string {
  if (report.releases.length === 0) return ''
  const lines = report.releases.map((release) =>
    (release.required ?? report.required.includes(release.rung))
      ? `required rung ${release.rung}: deploy exit ${release.deployExit ?? 'not run'}; ${release.outputTail || '(no output)'}`
      : `rung ${release.rung}: not required; ${(release.outputTail || '(no reason)').replace('<project>', project)}`,
  )
  if (!report.satisfied) {
    const rung = report.releases.find((release) => !release.satisfied)!.rung
    lines.push(
      `remedy: ${PLATFORM_SLUG} pr merge ${target} --release-required${releaseDepthFlag(depth)}, or ${PLATFORM_SLUG} release run ${project} --rung ${rung} and then ${PLATFORM_SLUG} pr merge ${target} --release-required${releaseDepthFlag(depth)}`,
    )
  }
  return lines.join('\n')
}
