// concern: release-preflight-adapter
/** Collects read-only repository and endpoint facts for release preflight. */

import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import type { PullRequestMergeFacts } from '../pull-request/pr-merge-evidence.ts'
import { releaseProcessEnvironment } from './release-decision.ts'
import { entryClosureAtCommit } from './release-entry-closure.ts'
import { RELEASE_LIVE_READING_TIMEOUT_MS } from './live-reading.ts'
import {
  decidePreflight,
  preflightRungs,
  type ReleasePreflightRung,
  type ReleaseProbeResult,
} from './release-preflight.ts'
import { git } from '../git/git-environment.ts'

export type ReleasePreflightInput = {
  project: Project
  pullRequest: PullRequestMergeFacts
  target: string
}

function runProbe(command: string, cwd: string): { ok: boolean; stderr: string } {
  const result = Bun.spawnSync(['/bin/sh', '-lc', command], {
    cwd,
    env: releaseProcessEnvironment(targetGitEnvironment(cwd)),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: RELEASE_LIVE_READING_TIMEOUT_MS,
  })
  const stderr = result.exitedDueToTimeout
    ? `probe timed out after ${RELEASE_LIVE_READING_TIMEOUT_MS / 1_000}s`
    : result.stderr.toString().trim()
  return { ok: result.exitCode === 0 && !result.exitedDueToTimeout, stderr }
}

function changedPaths(input: ReleasePreflightInput): string[] {
  const { project, pullRequest } = input
  return splitNulPaths(
    git(
      nulPathListArgs([
        'diff',
        '--name-only',
        `${pullRequest.baseBranch}...${pullRequest.headCommit}`,
      ]),
      project.path,
      targetGitEnvironment(project.path),
      ' while reading pull-request paths for release preflight',
    ),
  )
}

function requiredRungs(input: ReleasePreflightInput): ReleasePreflightRung[] {
  const rungs = input.project.settings.release?.rungs ?? []
  const entries = [...new Set(rungs.flatMap((rung) => rung.entryPoints ?? []))]
  const closure = entries.length
    ? entryClosureAtCommit(input.project, input.pullRequest.headCommit, entries)
    : new Map()
  return preflightRungs(rungs, changedPaths(input), closure, input.project.settings.trunk!)
}

function probeRung(rung: ReleasePreflightRung, cwd: string): ReleaseProbeResult {
  const live = rung.live ?? rung.liveVersion?.command
  if (!live) throw new Error(`required release rung ${rung.name} has no live probe`)
  return {
    rung: rung.name,
    ...(rung.preflight ? { preflight: runProbe(rung.preflight, cwd) } : {}),
    live: runProbe(live, cwd),
  }
}

export async function runReleasePreflight(input: ReleasePreflightInput): Promise<void> {
  const decision = decidePreflight(
    requiredRungs(input).map((rung) => probeRung(rung, input.project.path)),
  )
  if (!decision.ok) {
    throw new Error(decision.refusal.replace('<target>', input.target))
  }
  for (const notice of decision.notices) console.log(notice)
}
