import { categorizeFile } from '../../shared/file-kind.ts'
import { targetGitEnvironment } from './worktree.ts'

export type ReviewTier = {
  tier: 0 | 1 | 2 | 3
  risk: 0 | 1 | 2 | 3
  size: 0 | 1 | 2 | 3
  reasons: string[]
}

export type ReviewTierFile = { path: string; insertions: number; deletions: number }

export const REVIEW_HOT_PATHS: readonly {
  tier: 1 | 2 | 3
  pattern: RegExp
  reason: string
}[] = [
  { tier: 3, pattern: /^orchestrator\/src\/db\.ts$/, reason: 'schema and DDL' },
  { tier: 3, pattern: /^orchestrator\/src\/landing\.ts$/, reason: 'landing safety' },
  { tier: 3, pattern: /^orchestrator\/src\/worktree\.ts$/, reason: 'worktree lifecycle' },
  { tier: 3, pattern: /^orchestrator\/src\/run\.ts$/, reason: 'run execution' },
  { tier: 3, pattern: /^orchestrator\/hooks\//, reason: 'repository hooks' },
  { tier: 3, pattern: /^\.githooks\//, reason: 'repository hooks' },
  { tier: 3, pattern: /^\.claude\/settings\.json$/, reason: 'agent settings' },
  { tier: 3, pattern: /^shared\//, reason: 'cross-concern shared code' },
  { tier: 2, pattern: /^orchestrator\/src\//, reason: 'orchestrator source' },
  { tier: 2, pattern: /^hub\/src\//, reason: 'hub backend source' },
  { tier: 1, pattern: /^hub\/web\//, reason: 'hub web surface' },
  { tier: 1, pattern: /^\.claude\/skills\//, reason: 'agent skill' },
]

const isOrdinaryConfig = (path: string) => {
  const kind = categorizeFile(path)
  return kind === 'config' || (/\.json$/i.test(path) && kind !== 'generated')
}

const isReviewExcluded = (path: string) => {
  const kind = categorizeFile(path)
  return kind === 'generated' || kind === 'test' || kind === 'docs' || /(^|\/)fixtures?\//i.test(path)
}

export function classifyReviewTier(input: { files: ReviewTierFile[] }): ReviewTier {
  let risk: 0 | 1 | 2 | 3 = 0
  let riskReason = input.files.length === 0
    ? 'risk 0: no branch-side change'
    : 'risk 0: only documentation, tests, fixtures, or configuration paths'
  for (const file of input.files) {
    const kind = categorizeFile(file.path)
    const excluded = file.path !== '.claude/settings.json' && isReviewExcluded(file.path)
    if (excluded) continue
    const match = REVIEW_HOT_PATHS.find((entry) => entry.pattern.test(file.path))
    const ordinaryConfig = isOrdinaryConfig(file.path)
    const candidate = match?.tier ?? (kind === 'product' && !ordinaryConfig ? 2 : 0)
    if (candidate > risk) {
      risk = candidate
      riskReason = match
        ? `risk ${candidate}: ${file.path} (${match.reason})`
        : `risk 2: unlisted product path ${file.path}`
    }
  }

  const productFiles = input.files.filter((file) =>
    categorizeFile(file.path) === 'product' && !isOrdinaryConfig(file.path) && !isReviewExcluded(file.path))
  const countedFiles = input.files.filter((file) => !isReviewExcluded(file.path))
  const productLines = countedFiles.reduce((sum, file) => sum + file.insertions + file.deletions, 0)
  let size: 0 | 1 | 2 | 3 = productLines <= 10 ? 0 : productLines <= 50 ? 1 : productLines <= 400 ? 2 : 3
  const reasons = [riskReason, `size ${size}: ${productLines} product lines`]
  if (productFiles.length > 8 && size < 3) {
    size = (size + 1) as 1 | 2 | 3
    reasons[1] = `size ${size}: ${productLines} product lines across ${productFiles.length} product files (more than 8 raises size one tier)`
  }
  return { tier: Math.max(risk, size) as 0 | 1 | 2 | 3, risk, size, reasons }
}

export function diffNumstat(repo: string, from: string, to: string): ReviewTierFile[] {
  const result = Bun.spawnSync(['git', 'diff', '--numstat', `${from}..${to}`], {
    cwd: repo, env: targetGitEnvironment(repo), stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git diff exited ${result.exitCode}`)
  return result.stdout.toString().trim().split('\n').filter(Boolean).map((line) => {
    const [added, removed, ...path] = line.split('\t')
    return { path: path.join('\t'), insertions: Number(added) || 0, deletions: Number(removed) || 0 }
  })
}
