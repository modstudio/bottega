// concern: release-required
/** Decides and runs release rungs made mandatory by the merged change. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { git, gitResult, targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { declaredGlobsMatch } from '../review/review-declared-globs.ts'
import { type EntryClosure, entryClosureAtCommit } from './release-entry-closure.ts'
import {
  newestSuccessfulLiveReleaseCommit,
  type ReleaseResult,
  releaseProject,
} from './release-service.ts'

export type RequiredReleaseRung = {
  name: string
  onDemand?: boolean
  requiredWhenChanged?: readonly string[]
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

export type RequiredRungDecision =
  | { decided: true; required: string[]; error: null }
  | { decided: false; required: string[]; error: string }

/** Own the required-rung policy, including a failure to inspect the landed paths. */
export function requiredRungDecision(
  project: Project,
  readChangedPaths: () => readonly string[],
  readEntryClosure: (entries: readonly string[]) => EntryClosure,
): RequiredRungDecision {
  const rungs = project.settings.release?.rungs ?? []
  const declared = rungs.filter(
    (rung) => rung.requiredWhenChanged !== undefined || rung.entryPoints !== undefined,
  )
  if (declared.length === 0) return { decided: true, required: [], error: null }
  try {
    const changedPaths = readChangedPaths()
    const entries = [...new Set(rungs.flatMap((rung) => rung.entryPoints ?? []))]
    const entryClosure = entries.length > 0 ? readEntryClosure(entries) : new Map()
    return {
      decided: true,
      required: decideRequiredRungs(rungs, changedPaths, entryClosure),
      error: null,
    }
  } catch (cause) {
    return {
      decided: false,
      required: declared.map((rung) => rung.name),
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

export type RequiredReleaseRunner = {
  changedPaths(project: Project, mergeCommit: string): string[]
  entryClosure(project: Project, mergeCommit: string, entries: readonly string[]): EntryClosure
  prepareMain(project: Project): void
  newestLive(project: Project, rung: string): string | null
  contains(project: Project, ancestor: string, descendant: string): boolean
  release(project: Project, rung: string): ReleaseResult
}

const requiredReleaseRunner: RequiredReleaseRunner = {
  changedPaths,
  entryClosure: entryClosureAtCommit,
  prepareMain(project) {
    verifyMainCheckout(project)
  },
  newestLive(project, rung) {
    return newestSuccessfulLiveReleaseCommit(project.name, rung)
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

function failure(rung: string, detail: string): RequiredRungRelease {
  return { rung, deployExit: null, outputTail: detail, satisfied: false, deployed: false }
}

export function failedRequiredRelease(required: string[], detail: string): RequiredReleaseReport {
  return {
    required,
    releases: required.map((rung) => failure(rung, detail)),
    satisfied: required.length === 0,
  }
}

export function releaseRequiredFlagAbsent(required: string[]): RequiredReleaseReport {
  return failedRequiredRelease(required, 'not released because --release-required was absent')
}

export function releaseRequiredRungsAfterMainMove(input: {
  project: Project
  mergeCommit: string
  required: string[]
  runner?: RequiredReleaseRunner
}): RequiredReleaseReport {
  const runner = input.runner ?? requiredReleaseRunner
  return runRequiredReleaseRungs(input.project, input.mergeCommit, input.required, runner, false)
}

function runRequiredReleaseRungs(
  project: Project,
  mergeCommit: string,
  required: string[],
  runner: RequiredReleaseRunner,
  prepareMain: boolean,
): RequiredReleaseReport {
  if (required.length === 0) return { required, releases: [], satisfied: true }
  if (prepareMain) {
    try {
      runner.prepareMain(project)
    } catch (cause) {
      return failedRequiredRelease(required, cause instanceof Error ? cause.message : String(cause))
    }
  }
  const releases = required.map((rung): RequiredRungRelease => {
    try {
      const live = runner.newestLive(project, rung)
      if (live && runner.contains(project, mergeCommit, live)) {
        return {
          rung,
          deployExit: 0,
          outputTail: `already live at ${live}`,
          satisfied: true,
          deployed: false,
        }
      }
      const result = runner.release(project, rung)
      return {
        rung,
        deployExit: result.exitCode,
        outputTail: result.outputTail || result.warning || '(no deploy output)',
        satisfied: result.exitCode === 0 && result.liveMatchesCandidate === true,
        deployed: !result.alreadyLive,
      }
    } catch (cause) {
      return failure(rung, cause instanceof Error ? cause.message : String(cause))
    }
  })
  return { required, releases, satisfied: releases.every((release) => release.satisfied) }
}

export function releaseRequiredRungs(input: {
  project: Project
  mergeCommit: string
  releaseRequired: boolean
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
    )
  if (!decision.decided) return failedRequiredRelease(decision.required, decision.error)
  const required = decision.required
  if (required.length === 0) return { required, releases: [], satisfied: true }
  if (!input.releaseRequired) return releaseRequiredFlagAbsent(required)
  return runRequiredReleaseRungs(input.project, input.mergeCommit, required, runner, true)
}

export function formatRequiredReleaseReport(
  report: RequiredReleaseReport,
  target: string,
  project: string,
): string {
  if (report.required.length === 0) return ''
  const lines = report.releases.map(
    (release) =>
      `required rung ${release.rung}: deploy exit ${release.deployExit ?? 'not run'}; ${release.outputTail || '(no output)'}`,
  )
  if (!report.satisfied) {
    const rung = report.releases.find((release) => !release.satisfied)!.rung
    lines.push(
      `remedy: ${PLATFORM_SLUG} pr merge ${target} --release-required, or ${PLATFORM_SLUG} release run ${project} --rung ${rung} and then ${PLATFORM_SLUG} pr merge ${target} --release-required`,
    )
  }
  return lines.join('\n')
}
