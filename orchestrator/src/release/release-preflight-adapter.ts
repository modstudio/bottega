// concern: release-preflight-adapter
/** Collects read-only repository and endpoint facts for release preflight. */

import type { Project } from '../project/projects.ts'
import {
  type LiveReadingRunner,
  RELEASE_LIVE_READING_TIMEOUT_MS,
  runLiveCommand,
} from './live-reading.ts'
import { releaseCapturedText } from './release-decision.ts'
import { entryClosureAtCommit } from './release-entry-closure.ts'
import {
  decidePreflight,
  missingLiveProbeResult,
  preflightRungs,
  type ReleasePreflightRung,
  type ReleaseProbeCapture,
  type ReleaseProbeResult,
} from './release-preflight.ts'

export type ReleasePreflightInput = {
  project: Project
  headCommit: string
  changedPaths: readonly string[]
  target: string
}

export function runProbe(
  command: string,
  cwd: string,
  runner: LiveReadingRunner = runLiveCommand,
): ReleaseProbeCapture {
  const capture = runner(command, cwd, RELEASE_LIVE_READING_TIMEOUT_MS)
  return {
    command,
    exitCode: capture.exitCode,
    output: releaseCapturedText(capture.output),
    timedOut: capture.timedOut,
    timeoutMs: RELEASE_LIVE_READING_TIMEOUT_MS,
  }
}

function requiredRungs(input: ReleasePreflightInput): ReleasePreflightRung[] {
  const rungs = input.project.settings.release?.rungs ?? []
  const entries = [...new Set(rungs.flatMap((rung) => rung.entryPoints ?? []))]
  const closure = entries.length
    ? entryClosureAtCommit(input.project, input.headCommit, entries)
    : new Map()
  return preflightRungs(rungs, input.changedPaths, closure, input.project.settings.trunk!)
}

function probeRung(
  rung: ReleasePreflightRung,
  input: ReleasePreflightInput,
  allRungs: readonly ReleasePreflightRung[],
): ReleaseProbeResult {
  const live = rung.live ?? rung.liveVersion?.command
  if (!live) return missingLiveProbeResult(input.project.name, rung, allRungs)
  return {
    rung: rung.name,
    ...(rung.preflight ? { preflight: runProbe(rung.preflight, input.project.path) } : {}),
    live: runProbe(live, input.project.path),
  }
}

export async function runReleasePreflight(input: ReleasePreflightInput): Promise<void> {
  const allRungs = input.project.settings.release?.rungs ?? []
  const decision = decidePreflight(
    requiredRungs(input).map((rung) => probeRung(rung, input, allRungs)),
  )
  if (!decision.ok) {
    throw new Error(`refusing merge: ${decision.refusal.replace('<target>', input.target)}`)
  }
  for (const notice of decision.notices) console.log(notice)
}
