// concern: canon-write-gate
/** Knows the pure canon write decision. Must not know filesystems, stores, commands, runs, routing, or transports. */
import {
  type CanonFinding,
  type CanonSourceText,
  introducedCanonFindings,
  lintCanon,
} from './canon-lint.ts'

type Row = { slug: string; body: string }

export function decideCanonWrite(input: {
  current: Row[]
  next: Row[]
  trackedPaths: string[]
  packageScripts: string[]
  sourceTexts: CanonSourceText[]
}): CanonFinding[] {
  const lint = (rows: Row[]) =>
    lintCanon({
      files: rows.map(({ slug, body }) => ({ path: slug, text: body })),
      trackedPaths: input.trackedPaths,
      packageScripts: input.packageScripts,
      sourceTexts: input.sourceTexts,
    }).findings
  return introducedCanonFindings(lint(input.current), lint(input.next))
}
