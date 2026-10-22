import { categorizeFile } from '../../../shared/file-kind.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import type { ReviewRiskMap } from '../project/project-injection.ts'

export type ReviewTier = {
  tier: 0 | 1 | 2 | 3
  risk: 0 | 1 | 2 | 3
  size: 0 | 1 | 2 | 3
  reasons: string[]
  riskBasis: string | null
}

export type ReviewTierFile = { path: string; insertions: number; deletions: number }

type TierRangeEndpointKind = 'commit' | 'tree' | 'other' | 'unresolvable'

export type TierRangeEndpoint = {
  ref: string
  commit: string | null
  kind: TierRangeEndpointKind
}

export type TierRangeFacts = {
  from: TierRangeEndpoint
  to: TierRangeEndpoint
  mergeBase: string | null
}

const TIER_RANGE_FORMS = '<from>..<to> or <from>...<to>'

export function parseTierRange(
  value: string,
): { from: string; to: string } | { refusal: string } | null {
  const range = value.match(/^(.+?)(\.{2,})(.+)$/)
  if (!range) return null
  const [, from, separator, to] = range
  if ((separator !== '..' && separator !== '...') || to!.includes('..')) {
    return { refusal: `review tier range must use ${TIER_RANGE_FORMS}` }
  }
  return { from: from!, to: to! }
}

export function resolveTierRange(
  facts: TierRangeFacts,
): { from: string; to: string } | { refusal: string } {
  for (const endpoint of [facts.from, facts.to]) {
    if (endpoint.kind === 'unresolvable') {
      return {
        refusal:
          `tier range endpoint "${endpoint.ref}" could not be resolved to a commit; ` +
          'if this checkout lacks the ref, fetch it, or if it is not a valid revision expression, check the spelling',
      }
    }
    if (endpoint.kind !== 'commit') {
      return {
        refusal: `tier range endpoint "${endpoint.ref}" resolves to ${endpoint.kind === 'tree' ? 'a tree' : 'a non-commit object'}; run git rev-parse HEAD and supply a commit ref instead`,
      }
    }
  }
  if (!facts.mergeBase) {
    return {
      refusal:
        `could not establish a merge base for "${facts.from.ref}" and "${facts.to.ref}"; ` +
        'use refs from related histories, or for a shallow clone run git fetch --deepen=100 (or git fetch the missing history), then retry',
    }
  }
  return { from: facts.mergeBase, to: facts.to.commit! }
}

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

const isReviewExcluded = (path: string) => {
  if (
    path === '.claude/settings.json' ||
    AGENT_INSTRUCTION_PATHS.some(({ pattern }) => pattern.test(path))
  )
    return false
  const kind = categorizeFile(path)
  return (
    kind === 'generated' || kind === 'test' || kind === 'docs' || /(^|\/)fixtures?\//i.test(path)
  )
}

type FileRisk = { tier: 0 | 1 | 2 | 3; reason: string; basis: string | null }

function fileRisk(
  path: string,
  riskPaths: readonly CompiledReviewRiskPath[] | undefined,
  declaredUnlisted: 0 | 1 | 2 | undefined,
): FileRisk | null {
  if (isReviewExcluded(path)) return null
  const match =
    AGENT_INSTRUCTION_PATHS.find((entry) => entry.pattern.test(path)) ??
    riskPaths?.find((entry) => entry.pattern.test(path))
  if (match)
    return { tier: match.tier, reason: `${path} (${match.reason})`, basis: match.basis ?? null }
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

  const productFiles = input.files.filter(
    (file) =>
      categorizeFile(file.path) === 'product' &&
      !isOrdinaryConfig(file.path) &&
      !isReviewExcluded(file.path),
  )
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

export function diffNumstat(repo: string, from: string, to: string): ReviewTierFile[] {
  const result = Bun.spawnSync(['git', 'diff', '--no-renames', '--numstat', `${from}..${to}`], {
    cwd: repo,
    env: targetGitEnvironment(repo),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || `git diff exited ${result.exitCode}`)
  return result.stdout
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...path] = line.split('\t')
      return {
        path: path.join('\t'),
        insertions: Number(added) || 0,
        deletions: Number(removed) || 0,
      }
    })
}
