const NUMBER_PREDICATE =
  /\b(?:[A-Za-z_$][\w$]*\.)?number\s*(?:=\s*(?:\?|\$\d+|\$\{|[A-Za-z_$][\w$]*\.number\b)|IN\s*\()/gi
const IDENTIFIER_CLASSIFIER_CALL = /\bclassify[A-Za-z]+Identifier\s*\(/gi
const QUESTION_NUMBER_HELPER_CALL = /\b(?:questionByProjectNumber|questionByUnscopedNumber)\s*\(/g

export function identityReferenceViolationCount(source: string, file = ''): number {
  const numberPredicates = [...source.matchAll(NUMBER_PREDICATE)].length
  const classifiers = [...source.matchAll(IDENTIFIER_CLASSIFIER_CALL)].length
  const questionHelpers =
    file.startsWith('orchestrator/src/identity/') ||
    file.startsWith('orchestrator/src/question-store/')
      ? 0
      : [...source.matchAll(QUESTION_NUMBER_HELPER_CALL)].length
  return numberPredicates + classifiers + questionHelpers
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
