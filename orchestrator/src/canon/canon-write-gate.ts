// concern: canon-write-gate
/** Knows the pure canon write decision. Must not know filesystems, stores, commands, runs, routing, or transports. */
import {
  type CanonFinding,
  type CanonSourceText,
  introducedCanonFindings,
  lintCanon,
} from './canon-lint.ts'

type Row = { slug: string; body: string }

/** Rules that inspect tracked paths, source identifiers, or package scripts. */
const TREE_DEPENDENT_CANON_RULES = [
  'canon/reference-path',
  'canon/reference-symbol',
  'canon/reference-code',
  'canon/reference-script',
] as const

function treeFactsSupplied(input: {
  trackedPaths?: string[]
  packageScripts?: string[]
  sourceTexts?: CanonSourceText[]
}): boolean {
  return (
    input.trackedPaths !== undefined ||
    input.packageScripts !== undefined ||
    input.sourceTexts !== undefined
  )
}

export function decideCanonWrite(input: {
  current: Row[]
  next: Row[]
  trackedPaths?: string[]
  packageScripts?: string[]
  sourceTexts?: CanonSourceText[]
}): CanonFinding[] {
  const lint = (rows: Row[]) =>
    lintCanon({
      files: rows.map(({ slug, body }) => ({ path: slug, text: body })),
      trackedPaths: input.trackedPaths ?? [],
      packageScripts: input.packageScripts ?? [],
      sourceTexts: input.sourceTexts ?? [],
    }).findings
  const findings = introducedCanonFindings(lint(input.current), lint(input.next))
  if (treeFactsSupplied(input)) return findings
  const skipped = new Set<string>(TREE_DEPENDENT_CANON_RULES)
  return findings.filter((finding) => !skipped.has(finding.rule))
}

export function decideUserCanonImport(input: { current: Row[]; next: Row[] }): {
  bootstrap: boolean
  findings: CanonFinding[]
} {
  const bootstrap = input.current.length === 0
  return {
    bootstrap,
    findings: bootstrap
      ? lintCanon({
          files: input.next.map(({ slug, body }) => ({ path: slug, text: body })),
          trackedPaths: [],
          packageScripts: [],
          sourceTexts: [],
        }).findings
      : decideCanonWrite(input),
  }
}
