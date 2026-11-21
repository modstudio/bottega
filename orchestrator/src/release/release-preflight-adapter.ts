// concern: release-preflight-adapter
/** Collects read-only repository and endpoint facts for release preflight. */

import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { git, targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { releaseProcessEnvironment } from './release-decision.ts'
import { entryClosureAtCommit } from './release-entry-closure.ts'
import {
  decidePreflight,
  preflightRungs,
  type ReleasePreflightRung,
  type ReleaseProbeResult,
} from './release-preflight.ts'

export type ReleasePreflightInput = {
  project: Project
  baseBranch: string
  headCommit: string
  target: string
}

function runProbe(command: string, cwd: string): { ok: boolean; stderr: string } {
  try {
    const result = startBoundedSync(['/bin/sh', '-lc', command], {
      budget: 'sandbox-probe',
      cwd,
      env: releaseProcessEnvironment(targetGitEnvironment(cwd)),
    })
    return { ok: result.exitCode === 0, stderr: result.stderr.trim() }
  } catch (cause) {
    return { ok: false, stderr: cause instanceof Error ? cause.message : String(cause) }
  }
}

function changedPaths(input: ReleasePreflightInput): string[] {
  const { project } = input
  return splitNulPaths(
    git(
      nulPathListArgs(['diff', '--name-only', `${input.baseBranch}...${input.headCommit}`]),
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
    ? entryClosureAtCommit(input.project, input.headCommit, entries)
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
    throw new Error(`refusing merge: ${decision.refusal.replace('<target>', input.target)}`)
  }
  for (const notice of decision.notices) console.log(notice)
}
