const NUMBER_QUERY_OR_CLASSIFIER =
  /WHERE\s+(?:[-A-Za-z0-9_.]+\.)?number\s*=\s*\?|classify[A-Za-z]+Identifier\s*\(/g

export function identityReferenceViolationCount(source: string): number {
  return [...source.matchAll(NUMBER_QUERY_OR_CLASSIFIER)].length
}

export function identityReferenceGuardViolations(
  counts: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>>,
): string[] {
  const files = new Set([...Object.keys(counts), ...Object.keys(baseline)])
  return [...files].flatMap((file) => {
    if (file.startsWith('orchestrator/src/identity/')) return []
    const current = counts[file] ?? 0
    const allowed = baseline[file] ?? 0
    if (current === allowed) return []
    return [
      current > allowed
        ? `${file}: production identity bypass count grew from ${allowed} to ${current}; resolve the reference through identity/`
        : `${file}: production identity bypass count shrank from ${allowed} to ${current}; lower scripts/quality/identity-reference-baseline.ts`,
    ]
  })
}
