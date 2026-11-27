// concern: release-required
/** Decides and runs release rungs made mandatory by the merged change. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { git, gitResult, targetGitEnvironment } from '../git/git-environment.ts'
import { returnMainCheckoutToTrunkCommand } from '../project/main-checkout-invariant.ts'
import type { Project } from '../project/projects.ts'
import { declaredGlobsMatch } from '../review/review-declared-globs.ts'
import { canDeployRungFromReleaseTree } from './release-at-commit.ts'
import {
  releaseProofDecision,
  releaseRungCoversTarget,
  releaseRungProofRefusal,
  releaseRungProvenLiveAtCandidate,
} from './release-decision.ts'
import { type EntryClosure, entryClosureAtCommit } from './release-entry-closure.ts'
import {
  newestSuccessfulProvenReleaseCommit,
  type ReleaseResult,
  releaseProject,
} from './release-service.ts'
import { decideShipToReach, releaseDepthFlag, shipToRungs } from './ship-to-reach.ts'

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

export function rungsCanBeExplicitlyRequired(rungs: readonly RequiredReleaseRung[]): boolean {
  return rungs.some(
    (rung) => rung.requiredWhenChanged !== undefined || (rung.entryPoints?.length ?? 0) > 0,
  )
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
  canDeployFromTree?: boolean
}

export const RELEASE_REQUIREMENT_SOURCES = ['explicit', 'reach'] as const

export type RequiredRungDecision =
  | { decided: true; required: string[]; rungs: ReleaseRungPlan[]; error: null }
  | { decided: false; required: string[]; rungs: ReleaseRungPlan[]; error: string }

export function explicitlyRequiredRungs(decision: RequiredRungDecision): string[] {
  return decision.rungs
    .filter(({ required, requiredBy }) => required && requiredBy === 'explicit')
    .map(({ rung }) => rung)
}

export function requiredRungSentence(rungs: readonly string[]): string {
  return `${rungs.length === 1 ? 'release rung' : 'release rungs'} ${rungs.join(', ')} required by this pull request`
}

export type RequiredReleaseStep = 'deploy-rungs' | 'move-main' | 'hand-off'

/** Decide the only allowed ordering before adapters perform any side effect. */
export function requiredReleaseStepOrder(
  releaseRequired: boolean,
  plans: readonly Pick<ReleaseRungPlan, 'required' | 'canDeployFromTree'>[],
): RequiredReleaseStep[] {
  return releaseRequired &&
    plans.some(({ required, canDeployFromTree }) => required && canDeployFromTree)
    ? ['deploy-rungs', 'move-main', 'hand-off']
    : ['move-main', 'hand-off']
}

export function machineUpdateRungRefusal(input: {
  incomingCommit: string
  requiredRungs: readonly string[]
  provedCommits: ReadonlyMap<string, string | null>
  liveContainsIncoming: ReadonlyMap<string, boolean>
  liveIsAncestorOfIncoming: ReadonlyMap<string, boolean>
  requiredSinceLive: ReadonlyMap<string, boolean>
  project: string
}): string | null {
  for (const rung of input.requiredRungs) {
    const proved = input.provedCommits.get(rung) ?? null
    if (
      releaseRungProvenLiveAtCandidate({
        liveCommit: proved,
        liveContainsCandidate: input.liveContainsIncoming.get(rung) === true,
      }) ||
      releaseRungCoversTarget({
        liveCommit: proved,
        liveContainsTarget: input.liveContainsIncoming.get(rung) === true,
        targetContainsLive: input.liveIsAncestorOfIncoming.get(rung) === true,
        requiredSinceLive: input.requiredSinceLive.get(rung) !== false,
      })
    )
      continue
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
  project: Pick<Project, 'path' | 'settings'> | null,
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
      canDeployFromTree: project ? canDeployRungFromReleaseTree(project, rung) : false,
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
    null,
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
      project,
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
        canDeployFromTree: false,
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
    return releaseCommitContains(project, ancestor, descendant)
  },
  release(project, rung) {
    return releaseProject(project.name, rung, undefined, undefined)
  },
}

function releaseCommitContains(
  project: Pick<Project, 'path'>,
  ancestor: string,
  descendant: string,
): boolean {
  return gitResult(['merge-base', '--is-ancestor', ancestor, descendant], project.path).ok
}

function changedPathsBetween(project: Pick<Project, 'path'>, from: string, to: string): string[] {
  return splitNulPaths(
    git(
      nulPathListArgs(['diff', '--name-only', `${from}..${to}`, '--']),
      project.path,
      targetGitEnvironment(project.path),
      ` while reading release changes from ${from} to ${to}`,
    ),
  )
}

export type IncomingRequiredRungGuard = { refusal: string | null; elapsedMs: number }

export type ReleaseGuardProject = Pick<Project, 'name' | 'path' | 'settings'>

export type IncomingRequiredRungDependencies = {
  resolve(ref: string, project: ReleaseGuardProject): string
  changedPaths(project: ReleaseGuardProject, from: string, to: string): string[]
  entryClosure(
    project: ReleaseGuardProject,
    commit: string,
    entries: readonly string[],
  ): EntryClosure
  newestLive(project: ReleaseGuardProject, rung: string): string | null
  contains(project: ReleaseGuardProject, ancestor: string, descendant: string): boolean
  now(): number
}

const incomingRequiredRungDependencies: IncomingRequiredRungDependencies = {
  resolve: (ref, project) => git(['rev-parse', ref], project.path),
  changedPaths: changedPathsBetween,
  entryClosure: entryClosureAtCommit,
  newestLive: (project, rung) => newestSuccessfulProvenReleaseCommit(project.name, rung),
  contains: releaseCommitContains,
  now: () => performance.now(),
}

/** Gather release facts for the machine-update boundary inside the release concern. */
export function incomingRequiredRungGuard(
  project: ReleaseGuardProject,
  branch: string,
  dependencies: IncomingRequiredRungDependencies = incomingRequiredRungDependencies,
): IncomingRequiredRungGuard {
  const started = dependencies.now()
  const incoming = dependencies.resolve(`origin/${branch}`, project)
  const current = dependencies.resolve('HEAD', project)
  if (incoming === current) return { refusal: null, elapsedMs: dependencies.now() - started }
  const rungs = project.settings.release?.rungs ?? []
  const entries = [...new Set(rungs.flatMap((rung) => rung.entryPoints ?? []))]
  const entryClosure = entries.length
    ? dependencies.entryClosure(project, incoming, entries)
    : new Map()
  const requiredRungs = decideRequiredRungs(
    rungs,
    dependencies.changedPaths(project, current, incoming),
    entryClosure,
  ).filter((name) => {
    const rung = rungs.find((candidate) => candidate.name === name)
    return (
      rung !== undefined &&
      rung.branch === project.settings.trunk &&
      canDeployRungFromReleaseTree(project, rung)
    )
  })
  const proved = new Map<string, string | null>()
  const contains = new Map<string, boolean>()
  const isAncestor = new Map<string, boolean>()
  const requiredSinceLive = new Map<string, boolean>()
  for (const rung of requiredRungs) {
    const commit = dependencies.newestLive(project, rung)
    proved.set(rung, commit)
    contains.set(rung, Boolean(commit && dependencies.contains(project, incoming, commit)))
    const commitIsAncestor = Boolean(commit && dependencies.contains(project, commit, incoming))
    isAncestor.set(rung, commitIsAncestor)
    if (commit && commitIsAncestor) {
      requiredSinceLive.set(
        rung,
        decideRequiredRungs(
          rungs,
          dependencies.changedPaths(project, commit, incoming),
          entryClosure,
        ).includes(rung),
      )
    }
  }
  return {
    refusal: machineUpdateRungRefusal({
      incomingCommit: incoming,
      requiredRungs,
      provedCommits: proved,
      liveContainsIncoming: contains,
      liveIsAncestorOfIncoming: isAncestor,
      requiredSinceLive,
      project: project.name,
    }),
    elapsedMs: dependencies.now() - started,
  }
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
  const prepared = prepareRequiredReleaseReport(input.project, input.rungs)
  const outcomes = new Map<string, RequiredRungRelease>()
  for (const plan of prepared.actionable) {
    try {
      const live = runner.newestLive(input.project, plan.rung)
      if (live && runner.contains(input.project, input.mergeCommit, live)) {
        outcomes.set(plan.rung, alreadyLiveOutcome(plan, live))
        continue
      }
      const result = runner.release(input.project, plan.rung)
      outcomes.set(plan.rung, releaseResultOutcome(plan, result))
    } catch (cause) {
      outcomes.set(plan.rung, failure(plan, cause instanceof Error ? cause.message : String(cause)))
    }
  }
  return finishRequiredReleaseReport(input.rungs, prepared, outcomes)
}

/** Release required rungs from lifecycle-backed trees before the registered checkout moves. */
export async function releaseRequiredRungsBeforeMainMove(input: {
  project: Project
  mergeCommit: string
  rungs: ReleaseRungPlan[]
  releaseAt(input: { project: string; rung: string; commit: string }): Promise<{
    result: ReleaseResult
    provisionMs: number
    deployMs: number
    releaseMs: number
    residue?: string
  }>
  now?: () => Date
}): Promise<RequiredReleaseReport> {
  const plans = input.rungs.filter(
    ({ required, canDeployFromTree }) => required && canDeployFromTree,
  )
  const prepared = prepareRequiredReleaseReport(input.project, plans)
  const outcomes = new Map<string, RequiredRungRelease>()
  for (const plan of prepared.actionable) {
    try {
      const report = await input.releaseAt({
        project: input.project.name,
        rung: plan.rung,
        commit: input.mergeCommit,
      })
      const timing = `provision ${report.provisionMs}ms, deploy ${report.deployMs}ms, release ${report.releaseMs}ms`
      const residue = report.residue ? `; release checkout residue: ${report.residue}` : ''
      outcomes.set(
        plan.rung,
        releaseResultOutcome(plan, report.result, {
          satisfiedOutput: `rung ${plan.rung} healthy at ${input.mergeCommit} ${(input.now ?? (() => new Date()))().toISOString()}`,
          suffix: ` (${timing})${residue}`,
        }),
      )
    } catch (cause) {
      outcomes.set(plan.rung, failure(plan, cause instanceof Error ? cause.message : String(cause)))
    }
  }
  return finishRequiredReleaseReport(plans, prepared, outcomes)
}

type PreparedRequiredRelease = {
  required: string[]
  actionable: ReleaseRungPlan[]
  settled: ReadonlyMap<string, RequiredRungRelease>
}

function prepareRequiredReleaseReport(
  project: Project,
  plans: ReleaseRungPlan[],
): PreparedRequiredRelease {
  const settled = new Map<string, RequiredRungRelease>()
  const actionable: ReleaseRungPlan[] = []
  for (const plan of plans) {
    if (!plan.required) {
      settled.set(plan.rung, failure(plan, plan.reason ?? 'not required'))
      continue
    }
    const proofRefusal = releaseRungProofRefusal(
      PLATFORM_SLUG,
      project.name,
      plan.rung,
      plan.branch,
      project.settings.release?.rungs ?? [],
    )
    if (proofRefusal) {
      settled.set(plan.rung, { ...failure(plan, proofRefusal), unprovable: true })
      continue
    }
    actionable.push(plan)
  }
  return {
    required: plans.filter(({ required }) => required).map(({ rung }) => rung),
    actionable,
    settled,
  }
}

function alreadyLiveOutcome(plan: ReleaseRungPlan, live: string): RequiredRungRelease {
  return {
    rung: plan.rung,
    required: true,
    deployExit: 0,
    outputTail: `already live at ${live}`,
    satisfied: true,
    deployed: false,
  }
}

function releaseResultOutcome(
  plan: ReleaseRungPlan,
  result: ReleaseResult,
  presentation?: { satisfiedOutput?: string; suffix?: string },
): RequiredRungRelease {
  const satisfied = releaseProofDecision({
    exitCode: result.exitCode,
    liveMatchesCandidate: result.liveMatchesCandidate,
    candidateContainsMerge: true,
  })
  return {
    rung: plan.rung,
    required: true,
    deployExit: result.exitCode,
    outputTail: `${satisfied && presentation?.satisfiedOutput ? presentation.satisfiedOutput : result.outputTail || result.warning || '(no deploy output)'}${presentation?.suffix ?? ''}`,
    satisfied,
    deployed: !result.alreadyLive,
  }
}

/** Combine pre-move proofs with the required rungs that must still run after main moves. */
export function releaseAfterProvedRequiredRelease(input: {
  plans: ReleaseRungPlan[]
  proved: RequiredReleaseReport
  releaseAfter(plans: ReleaseRungPlan[]): RequiredReleaseReport
}): RequiredReleaseReport {
  const remainingPlans = input.plans.map((plan) =>
    plan.required && plan.canDeployFromTree
      ? { ...plan, required: false, reason: 'proved before the main checkout moved' }
      : plan,
  )
  const after = input.releaseAfter(remainingPlans)
  const provedByRung = new Map(input.proved.releases.map((release) => [release.rung, release]))
  const afterByRung = new Map(after.releases.map((release) => [release.rung, release]))
  const releases = input.plans.map((plan) => {
    const proved = provedByRung.get(plan.rung)
    if (proved) return proved
    if (plan.required && plan.canDeployFromTree) {
      return failure(plan, `required rung ${plan.rung} is missing its pre-move release proof`)
    }
    return afterByRung.get(plan.rung) ?? failure(plan, `release rung ${plan.rung} was not run`)
  })
  return {
    required: input.plans.filter(({ required }) => required).map(({ rung }) => rung),
    releases,
    satisfied: releases.every(({ satisfied }) => satisfied),
  }
}

function finishRequiredReleaseReport(
  plans: ReleaseRungPlan[],
  prepared: PreparedRequiredRelease,
  outcomes: ReadonlyMap<string, RequiredRungRelease>,
): RequiredReleaseReport {
  const releases = plans.map(
    (plan) =>
      prepared.settled.get(plan.rung) ??
      outcomes.get(plan.rung) ??
      failure(plan, `release rung ${plan.rung} was not run`),
  )
  return {
    required: prepared.required,
    releases,
    satisfied: releases.every(({ satisfied }) => satisfied),
  }
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
