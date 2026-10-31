// concern: release-required
/** Decides and runs release rungs made mandatory by the merged change. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import {
  newestSuccessfulLiveReleaseCommit,
  type ReleaseResult,
  releaseProject,
} from './release-service.ts'

export type RequiredReleaseRung = {
  name: string
  onDemand?: boolean
  requiredWhenChanged?: readonly string[]
}

export function decideRequiredRungs(
  rungs: readonly RequiredReleaseRung[],
  changedPaths: readonly string[],
): string[] {
  return rungs
    .filter((rung) =>
      rung.requiredWhenChanged?.some((pattern) => {
        const glob = new Bun.Glob(pattern)
        return changedPaths.some((path) => glob.match(path))
      }),
    )
    .map((rung) => rung.name)
}

type CommandResult = { exitCode: number; output: string }

function git(cwd: string, args: string[]): CommandResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    output: [result.stdout.toString(), result.stderr.toString()].filter(Boolean).join('').trim(),
  }
}

function successfulGit(cwd: string, args: string[], label: string): string {
  const result = git(cwd, args)
  if (result.exitCode !== 0)
    throw new Error(`${label} failed: ${result.output || `exit ${result.exitCode}`}`)
  return result.output
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

export type RequiredReleaseRunner = {
  changedPaths(project: Project, mergeCommit: string): string[]
  prepareMain(project: Project): void
  newestLive(project: Project, rung: string): string | null
  contains(project: Project, ancestor: string, descendant: string): boolean
  release(project: Project, rung: string): ReleaseResult
}

const requiredReleaseRunner: RequiredReleaseRunner = {
  changedPaths(project, mergeCommit) {
    const trunk = project.settings.trunk!
    successfulGit(project.path, ['fetch', 'origin', trunk], 'landing-branch fetch')
    return successfulGit(
      project.path,
      ['diff', '--name-only', `${mergeCommit}^1`, mergeCommit],
      'merge first-parent diff',
    )
      .split('\n')
      .filter(Boolean)
  },
  prepareMain(project) {
    const trunk = project.settings.trunk!
    const branch = successfulGit(
      project.path,
      ['branch', '--show-current'],
      'main checkout branch lookup',
    )
    if (branch !== trunk) {
      throw new Error(
        `registered main checkout is on ${branch || 'detached HEAD'}, not ${trunk}; switch it to ${trunk}`,
      )
    }
    const dirty = successfulGit(project.path, ['status', '--porcelain'], 'main checkout status')
    if (dirty) throw new Error('registered main checkout is dirty; clean it')
    successfulGit(
      project.path,
      ['merge', '--ff-only', `origin/${trunk}`],
      'main checkout fast-forward',
    )
  },
  newestLive(project, rung) {
    return newestSuccessfulLiveReleaseCommit(project.name, rung)
  },
  contains(project, ancestor, descendant) {
    return git(project.path, ['merge-base', '--is-ancestor', ancestor, descendant]).exitCode === 0
  },
  release(project, rung) {
    return releaseProject(project.name, rung, undefined, undefined)
  },
}

function failure(rung: string, detail: string): RequiredRungRelease {
  return { rung, deployExit: null, outputTail: detail, satisfied: false, deployed: false }
}

export function releaseRequiredRungs(input: {
  project: Project
  mergeCommit: string
  releaseRequired: boolean
  runner?: RequiredReleaseRunner
}): RequiredReleaseReport {
  const runner = input.runner ?? requiredReleaseRunner
  const rungs = input.project.settings.release?.rungs ?? []
  const required = decideRequiredRungs(rungs, runner.changedPaths(input.project, input.mergeCommit))
  if (required.length === 0) return { required, releases: [], satisfied: true }
  if (!input.releaseRequired) {
    return {
      required,
      releases: required.map((rung) =>
        failure(rung, 'not released because --release-required was absent'),
      ),
      satisfied: false,
    }
  }
  try {
    runner.prepareMain(input.project)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { required, releases: required.map((rung) => failure(rung, detail)), satisfied: false }
  }
  const releases = required.map((rung): RequiredRungRelease => {
    const live = runner.newestLive(input.project, rung)
    if (live && runner.contains(input.project, input.mergeCommit, live)) {
      return {
        rung,
        deployExit: 0,
        outputTail: `already live at ${live}`,
        satisfied: true,
        deployed: false,
      }
    }
    try {
      const result = runner.release(input.project, rung)
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
