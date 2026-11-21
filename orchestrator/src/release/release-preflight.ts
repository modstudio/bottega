// concern: release-preflight
/** Decides which release probes are required and whether their results permit enqueue. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { EntryClosure } from './release-entry-closure.ts'
import { decideRequiredRungs, type RequiredReleaseRung } from './release-required.ts'

export type ReleasePreflightRung = RequiredReleaseRung & {
  preflight?: string
}

export type ReleaseProbeResult = {
  rung: string
  preflight?: { ok: boolean; stderr: string }
  live: { ok: boolean; stderr: string }
}

export type ReleasePreflightDecision =
  | { ok: true; notices: string[] }
  | { ok: false; refusal: string }

export function preflightRungs(
  rungs: readonly ReleasePreflightRung[],
  changedPaths: readonly string[],
  entryClosure: EntryClosure,
  landingBranch: string,
): ReleasePreflightRung[] {
  const required = new Set(decideRequiredRungs(rungs, changedPaths, entryClosure))
  return rungs.filter((rung) => rung.branch === landingBranch && required.has(rung.name))
}

function lastStderrLine(stderr: string): string {
  return stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '(no stderr)'
}

function failedProbe(rung: string, probe: 'credentials' | 'endpoint', stderr: string): string {
  const detail = lastStderrLine(stderr)
  const fix = detail.replace(/^REFUSE:\s*/, '')
  return `release preflight for ${rung} failed its ${probe} probe: ${detail}\ncleared by: ${fix}, then ${PLATFORM_SLUG} pr merge <target> --release-required`
}

export function decidePreflight(results: readonly ReleaseProbeResult[]): ReleasePreflightDecision {
  const notices: string[] = []
  for (const result of results) {
    if (result.preflight && !result.preflight.ok) {
      return {
        ok: false,
        refusal: failedProbe(result.rung, 'credentials', result.preflight.stderr),
      }
    }
    if (!result.preflight) notices.push(`credentials not checked for ${result.rung}`)
    if (!result.live.ok) {
      return { ok: false, refusal: failedProbe(result.rung, 'endpoint', result.live.stderr) }
    }
  }
  return { ok: true, notices }
}
