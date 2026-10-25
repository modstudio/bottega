// concern: review-tier-classifier
/** Pure review-tier classification over already-measured file facts. */

import { categorizeFile, type FileKind } from '../../../shared/file-kind.ts'
import type { ReviewRiskMap } from '../project/project-injection.ts'

export type ReviewTier = {
  tier: 0 | 1 | 2 | 3
  risk: 0 | 1 | 2 | 3
  size: 0 | 1 | 2 | 3
  reasons: string[]
  riskBasis: string | null
}

export type ReviewTierFile = { path: string; insertions: number; deletions: number }

type CompiledReviewRiskPath = Omit<ReviewRiskMap['paths'][number], 'pattern'> & {
  pattern: RegExp
}

const AGENT_INSTRUCTION_PATHS: readonly CompiledReviewRiskPath[] = [
  { tier: 1, pattern: /^\.claude\/skills\//, reason: 'agent skill' },
  { tier: 1, pattern: /^\.agents\/skills\//, reason: 'agent skill' },
  {
    tier: 1,
    pattern: /^\.agents\/(?:workflow-steps|workflows)\//,
    reason: 'workflow instructions',
  },
]

const isOrdinaryConfig = (path: string) => {
  const kind = categorizeFile(path)
  return kind === 'config' || (/\.json$/i.test(path) && kind !== 'generated')
}

const isTestOrFixture = (path: string) =>
  categorizeFile(path) === 'test' ||
  /(^|\/)fixtures?\//i.test(path) ||
  /\.fixtures?\.[^/]+$/i.test(path)

const isReviewExcluded = (path: string) => {
  if (
    path === '.claude/settings.json' ||
    AGENT_INSTRUCTION_PATHS.some(({ pattern }) => pattern.test(path))
  )
    return false
  const kind = categorizeFile(path)
  return kind === 'generated' || kind === 'docs' || isTestOrFixture(path)
}

/** Whether a recorded path belongs to the product surface used for review decisions. */
export function isReviewProductPath(path: string, kind: FileKind = categorizeFile(path)): boolean {
  return kind === 'product' && !isOrdinaryConfig(path) && !isReviewExcluded(path)
}

type FileRisk = { tier: 0 | 1 | 2 | 3; reason: string; basis: string | null }

function fileRisk(
  path: string,
  riskPaths: readonly CompiledReviewRiskPath[] | undefined,
  declaredUnlisted: 0 | 1 | 2 | undefined,
): FileRisk | null {
  const instructionMatch = AGENT_INSTRUCTION_PATHS.find((entry) => entry.pattern.test(path))
  if (instructionMatch)
    return {
      tier: instructionMatch.tier,
      reason: `${path} (${instructionMatch.reason})`,
      basis: instructionMatch.basis ?? null,
    }
  if (isTestOrFixture(path)) return null
  const match = riskPaths?.find((entry) => entry.pattern.test(path))
  if (match)
    return { tier: match.tier, reason: `${path} (${match.reason})`, basis: match.basis ?? null }
  if (isReviewExcluded(path)) return null
  const kind = categorizeFile(path)
  if (kind !== 'product' || isOrdinaryConfig(path)) return null
  const tier = declaredUnlisted ?? 2
  const applied =
    declaredUnlisted === undefined
      ? 'fail-closed default risk 2 applied'
      : `project unlisted risk ${declaredUnlisted} applied`
  return { tier, reason: `unlisted product path ${path} (${applied})`, basis: null }
}

const compileRiskPaths = (
  riskMap: ReviewRiskMap | undefined,
): CompiledReviewRiskPath[] | undefined =>
  riskMap?.paths.map((entry) => ({
    ...entry,
    pattern: new RegExp(entry.pattern),
  }))

function classifyRisk(
  files: readonly ReviewTierFile[],
  riskMap: ReviewRiskMap | undefined,
): { risk: 0 | 1 | 2 | 3; reason: string; basis: string | null } {
  const riskPaths = compileRiskPaths(riskMap)
  let risk: 0 | 1 | 2 | 3 = 0
  let reason =
    files.length === 0
      ? 'risk 0: no branch-side change'
      : 'risk 0: only documentation, tests, fixtures, or configuration paths'
  let classified = false
  let basis: string | null = null
  for (const file of files) {
    const candidate = fileRisk(file.path, riskPaths, riskMap?.unlisted)
    if (!candidate || (classified && candidate.tier <= risk)) continue
    risk = candidate.tier
    reason = `risk ${candidate.tier}: ${candidate.reason}`
    basis = candidate.basis
    classified = true
  }
  return { risk, reason, basis }
}

export function classifyReviewTier(input: {
  files: ReviewTierFile[]
  risk?: ReviewRiskMap
}): ReviewTier {
  const { risk, reason: riskReason, basis: riskBasis } = classifyRisk(input.files, input.risk)

  const productFiles = input.files.filter((file) => isReviewProductPath(file.path))
  const countedFiles = input.files.filter((file) => !isReviewExcluded(file.path))
  const productLines = countedFiles.reduce((sum, file) => sum + file.insertions + file.deletions, 0)
  let size: 0 | 1 | 2 | 3 =
    productLines <= 10 ? 0 : productLines <= 50 ? 1 : productLines <= 400 ? 2 : 3
  const reasons = [riskReason, `size ${size}: ${productLines} product lines`]
  if (productFiles.length > 8 && size < 3) {
    size = (size + 1) as 1 | 2 | 3
    reasons[1] = `size ${size}: ${productLines} product lines across ${productFiles.length} product files (more than 8 raises size one tier)`
  }
  return { tier: Math.max(risk, size) as 0 | 1 | 2 | 3, risk, size, reasons, riskBasis }
}

/** Paths whose declared surface risk independently requires tier-three review. */
export function tierThreeRiskPaths(
  files: readonly ReviewTierFile[],
  riskMap: ReviewRiskMap | undefined,
): string[] {
  const riskPaths = compileRiskPaths(riskMap)
  return files
    .filter((file) => fileRisk(file.path, riskPaths, riskMap?.unlisted)?.tier === 3)
    .map(({ path }) => path)
}
