// concern: document-history-presentation
/** Shared revision-history presentation contract and diff-pair selection. */

export type DocHistoryPresentation<RevisionRow, Revision> = {
  revisions: RevisionRow[]
  resolve(identifier: string): string
  revision(identifier: string): Revision
  diff(a: string | undefined, b: string | undefined): string
}

export function docDiffPair<T>(
  revisions: readonly T[],
  a: T | undefined,
  b: T | undefined,
): readonly [T, T] {
  const left = a ?? revisions[1]
  const right = b ?? revisions[0]
  if (left === undefined || right === undefined)
    throw new Error('doc diff needs two revisions; this address has fewer than two')
  return [left, right]
}
