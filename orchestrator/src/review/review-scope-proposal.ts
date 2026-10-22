// concern: review-scope-proposal
/**
 * Proposes path scopes from recorded review evidence and declared repository
 * structure. Must not know stores, filesystems, clocks, or processes.
 */

import type { ReviewSettings } from '../project/project-injection.ts'
import { declaredGlobsMatch } from './review-declared-globs.ts'
import { isMediumPlusHit, type YieldFinding } from './review-yield-slice.ts'

const MINIMUM_KEPT_SHARE = 0.9

export type ReviewScopeRun = {
  id: string
  lens: string
  paths: string[] | null
  complete: boolean
  findings: YieldFinding[]
}

export type ReviewScopeProject = {
  project: string
  topLevelDirectories: string[]
  review: ReviewSettings
  runs: ReviewScopeRun[]
}

type ReviewScopeLensProposal = {
  lens: string
  disposition: 'propose' | 'keep-unscoped'
  globs: string[]
  acceptedMediumPlus: { kept: number; total: number; share: number | null }
  runs: { skipped: number; total: number; share: number | null; unrecorded: number }
}

type ReviewScopeProjectProposal = {
  project: string
  lenses: ReviewScopeLensProposal[]
}

export type ReviewScopeProposalReport = {
  findingAttribution: string
  projects: ReviewScopeProjectProposal[]
}

const attribution =
  "A finding counts as kept when its review's recorded paths match the proposed globs, not by the finding's own location."

function candidates(project: ReviewScopeProject): string[] {
  const globs = [
    ...project.topLevelDirectories.map((directory) => `${directory}/**`),
    ...project.review.lenses.flatMap((entry) => entry.paths ?? []),
  ]
  return [...new Set(globs)].sort()
}

function matches(run: ReviewScopeRun, globs: readonly string[]): boolean {
  return run.paths !== null && declaredGlobsMatch(run.paths, globs)
}

function hitCount(runs: readonly ReviewScopeRun[], globs: readonly string[]): number {
  return runs
    .filter((run) => matches(run, globs))
    .reduce(
      (total, run) => total + run.findings.filter((finding) => isMediumPlusHit(finding)).length,
      0,
    )
}

function matchingRunCount(runs: readonly ReviewScopeRun[], globs: readonly string[]): number {
  return runs.filter((run) => matches(run, globs)).length
}

/** Greedily choose the narrowest useful declared areas that preserve the evidence floor. */
function proposedGlobs(
  runs: readonly ReviewScopeRun[],
  available: readonly string[],
  totalHits: number,
): string[] {
  const selected: string[] = []
  const remaining = new Set(available)
  while (hitCount(runs, selected) / totalHits < MINIMUM_KEPT_SHARE) {
    const before = hitCount(runs, selected)
    const ranked = [...remaining]
      .map((glob) => {
        const next = [...selected, glob]
        return {
          glob,
          addedHits: hitCount(runs, next) - before,
          matchedRuns: matchingRunCount(runs, next),
        }
      })
      .filter(({ addedHits }) => addedHits > 0)
      .sort(
        (a, b) =>
          b.addedHits - a.addedHits ||
          a.matchedRuns - b.matchedRuns ||
          a.glob.localeCompare(b.glob),
      )
    const next = ranked[0]
    if (!next) break
    selected.push(next.glob)
    remaining.delete(next.glob)
  }

  for (const glob of [...selected].reverse()) {
    const without = selected.filter((candidate) => candidate !== glob)
    if (hitCount(runs, without) / totalHits >= MINIMUM_KEPT_SHARE)
      selected.splice(selected.indexOf(glob), 1)
  }
  return selected.sort()
}

export function proposeReviewScopes(
  projects: readonly ReviewScopeProject[],
): ReviewScopeProposalReport {
  return {
    findingAttribution: attribution,
    projects: [...projects]
      .sort((a, b) => a.project.localeCompare(b.project))
      .map((project) => ({
        project: project.project,
        lenses: project.review.lenses
          .filter((entry) => !entry.paths)
          .filter(
            (entry, index, entries) =>
              entries.findIndex((candidate) => candidate.lens === entry.lens) === index,
          )
          .map((entry) => proposalForLens(entry.lens, project.runs, candidates(project))),
      })),
  }
}

function proposalForLens(
  lens: string,
  allRuns: readonly ReviewScopeRun[],
  available: readonly string[],
): ReviewScopeLensProposal {
  const runs = allRuns.filter((run) => run.lens === lens)
  const evidenceRuns = runs.filter((run) => run.complete)
  const totalHits = evidenceRuns.reduce(
    (total, run) => total + run.findings.filter((finding) => isMediumPlusHit(finding)).length,
    0,
  )
  const globs = totalHits ? proposedGlobs(evidenceRuns, available, totalHits) : []
  const kept = globs.length ? hitCount(evidenceRuns, globs) : 0
  const recordedRuns = runs.filter((run) => run.paths !== null)
  const skipped = globs.length ? recordedRuns.length - matchingRunCount(recordedRuns, globs) : 0
  const keptShare = totalHits ? kept / totalHits : null
  const useful = keptShare !== null && keptShare >= MINIMUM_KEPT_SHARE && skipped > 0
  return {
    lens,
    disposition: useful ? 'propose' : 'keep-unscoped',
    globs: useful ? globs : [],
    acceptedMediumPlus: { kept, total: totalHits, share: keptShare },
    runs: {
      skipped: useful ? skipped : 0,
      total: recordedRuns.length,
      share: recordedRuns.length && useful ? skipped / recordedRuns.length : null,
      unrecorded: runs.length - recordedRuns.length,
    },
  }
}

const percent = (value: number | null): string =>
  value === null ? '—' : `${(value * 100).toFixed(1)}%`

export function renderReviewScopeProposalHuman(report: ReviewScopeProposalReport): string {
  const lines = [report.findingAttribution]
  for (const project of report.projects) {
    lines.push('', project.project)
    if (!project.lenses.length) lines.push('  (no unscoped lenses)')
    for (const lens of project.lenses) {
      const scope = lens.disposition === 'propose' ? lens.globs.join(', ') : 'keep unscoped'
      lines.push(
        `  ${lens.lens}: ${scope}; keeps ${lens.acceptedMediumPlus.kept}/${lens.acceptedMediumPlus.total} ` +
          `medium+ accepted findings (${percent(lens.acceptedMediumPlus.share)}); skips ` +
          `${lens.runs.skipped}/${lens.runs.total} recorded-path runs (${percent(lens.runs.share)})` +
          (lens.runs.unrecorded ? `; ${lens.runs.unrecorded} run(s) lack recorded paths` : ''),
      )
    }
  }
  return lines.join('\n')
}
