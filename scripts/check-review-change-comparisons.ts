// concern: review-change-comparison-check
/** Refuses comparisons that bypass the one same-change decision. */

import { readFileSync } from 'node:fs'

const allowed = new Set([
  'orchestrator/src/review/same-change.ts',
  'orchestrator/src/evidence/evidence-query.ts',
  'scripts/measure-review-rebase-carries.ts',
  'scripts/check-review-change-comparisons.ts',
])

const identifier = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`
const comparison = new RegExp(
  String.raw`\b(${identifier})\s*(===|!==|==|!=|=|IS\s+NOT|IS)\s*(${identifier})\b`,
  'gi',
)
const identityIdentifier =
  /^(?:patchId|zeroContextPatchId|(?:[A-Za-z_]\w*_)?patch_id|(?:[A-Za-z_]\w*_)?zero_context_patch_id)$/

const lastSegment = (value: string) => value.split('.').at(-1) ?? ''

/** Find line numbers where both sides of a comparison are change identities. */
export function changeComparisonLines(source: string): number[] {
  const lines: number[] = []
  for (const match of source.matchAll(comparison)) {
    const sqlUpsertAssignment = match[2] === '=' && /^excluded\./i.test(match[3]!)
    if (
      !sqlUpsertAssignment &&
      identityIdentifier.test(lastSegment(match[1]!)) &&
      identityIdentifier.test(lastSegment(match[3]!))
    ) {
      lines.push(source.slice(0, match.index).split('\n').length)
    }
  }
  return lines
}

if (import.meta.main) {
  const findings: string[] = []
  const paths = [
    ...new Bun.Glob('orchestrator/src/**/*.ts').scanSync({ onlyFiles: true }),
    ...new Bun.Glob('scripts/**/*.ts').scanSync({ onlyFiles: true }),
  ]
  for (const path of paths) {
    if (path.endsWith('.test.ts') || allowed.has(path)) continue
    const source = readFileSync(path, 'utf8')
    for (const line of changeComparisonLines(source)) {
      findings.push(
        `${path}:${line}: route patch identity comparison through sameChange or sameChangeSql`,
      )
    }
  }

  if (findings.length) {
    console.error(findings.join('\n'))
    process.exit(1)
  }
  console.log('review change comparisons: one decision')
}
