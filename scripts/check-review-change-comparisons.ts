// concern: review-change-comparison-check
/** Refuses comparisons that bypass the one same-change decision. */

import { readFileSync } from 'node:fs'

const allowed = new Set([
  'orchestrator/src/review/same-change.ts',
  'orchestrator/src/evidence/evidence-query.ts',
])
const comparison =
  /(?:\bpatchId\s*(?:===|!==|==|!=)\s*[^\n,;)]*\bpatchId\b|\bAND[^\n]*\bpatch_id\s*(?:=|IS)\s*(?:[A-Za-z_]\w*\.)?patch_id\b)/g
const findings: string[] = []

for (const path of new Bun.Glob('orchestrator/src/**/*.ts').scanSync({ onlyFiles: true })) {
  if (path.endsWith('.test.ts') || allowed.has(path)) continue
  const source = readFileSync(path, 'utf8')
  for (const match of source.matchAll(comparison)) {
    const line = source.slice(0, match.index).split('\n').length
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
