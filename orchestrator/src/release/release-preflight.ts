// concern: release-preflight
/** Decides which release probes are required and whether their results permit enqueue. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { unprovableReleaseRungMessage } from './release-decision.ts'
import type { EntryClosure } from './release-entry-closure.ts'
import { decideRequiredRungs, type RequiredReleaseRung } from './release-required.ts'

export type ReleasePreflightRung = RequiredReleaseRung

export type ReleaseProbeCapture = {
  command: string
  exitCode: number
  output: string
  timedOut: boolean
  timeoutMs: number
}

export type ReleaseProbeResult =
  | {
      rung: string
      preflight?: ReleaseProbeCapture
      live: ReleaseProbeCapture
      missingLiveRefusal?: never
    }
  | {
      rung: string
      preflight?: never
      live?: never
      missingLiveRefusal: string
    }

export type ReleasePreflightDecision =
  | { ok: true; notices: string[] }
  | { ok: false; refusal: string }

export function missingLiveProbeResult(
  project: string,
  rung: ReleasePreflightRung,
  rungs: readonly ReleasePreflightRung[],
): ReleaseProbeResult {
  return {
    rung: rung.name,
    missingLiveRefusal: unprovableReleaseRungMessage(
      PLATFORM_SLUG,
      project,
      rung.name,
      rung.branch,
      rungs,
    ),
  }
}

export function preflightRungs(
  rungs: readonly ReleasePreflightRung[],
  changedPaths: readonly string[],
  entryClosure: EntryClosure,
  landingBranch: string,
): ReleasePreflightRung[] {
  const required = new Set(decideRequiredRungs(rungs, changedPaths, entryClosure))
  return rungs.filter((rung) => rung.branch === landingBranch && required.has(rung.name))
}

function lastOutputLine(output: string): string | null {
  return output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? null
}

function failedProbe(
  rung: string,
  probe: 'credentials' | 'endpoint',
  capture: ReleaseProbeCapture,
): string {
  const lastLine = lastOutputLine(capture.output)
  const detail = capture.timedOut
    ? `timed out after ${capture.timeoutMs}ms`
    : (lastLine ?? `exited ${capture.exitCode} with no output`)
  const fix = lastLine?.startsWith('REFUSE:')
    ? lastLine.replace(/^REFUSE:\s*/, '')
    : `make \`${capture.command}\` succeed`
  return renderRefusal(
    refusal(
      `release preflight for ${rung} failed its ${probe} probe command ${JSON.stringify(capture.command)}: ${detail}`,
      {
        kind: 'edit',
        text: `${fix}, then ${PLATFORM_SLUG} pr merge <target> --release-required`,
      },
    ),
  )
}

export function decidePreflight(results: readonly ReleaseProbeResult[]): ReleasePreflightDecision {
  const notices: string[] = []
  for (const result of results) {
    if (result.missingLiveRefusal) {
      return { ok: false, refusal: result.missingLiveRefusal }
    }
    if (result.preflight && (result.preflight.timedOut || result.preflight.exitCode !== 0)) {
      return {
        ok: false,
        refusal: failedProbe(result.rung, 'credentials', result.preflight),
      }
    }
    if (!result.preflight) notices.push(`credentials not checked for ${result.rung}`)
    if (result.live && (result.live.timedOut || result.live.exitCode !== 0)) {
      return { ok: false, refusal: failedProbe(result.rung, 'endpoint', result.live) }
    }
  }
  return { ok: true, notices }
}
