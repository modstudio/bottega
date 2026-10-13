import { structuredPatch } from 'diff'

type RevisionComparison<T> = { kind: 'current' } | { kind: 'revision'; id: T }

/** The body that replaced a stored revision, given revision ids newest first. */
export function revisionComparison<T>(
  revisionIds: readonly T[],
  selectedId: T,
): RevisionComparison<T> | null {
  const selectedIndex = revisionIds.indexOf(selectedId)
  if (selectedIndex < 0) return null
  const newerId = revisionIds[selectedIndex - 1]
  return newerId === undefined ? { kind: 'current' } : { kind: 'revision', id: newerId }
}

type ShapedDiffLine = {
  kind: 'added' | 'removed' | 'context'
  mark: '+' | '-' | ' '
  number: number
  text: string
}

type ShapedDiff = { identical: boolean; hunks: ShapedDiffLine[][] }

/** Shape jsdiff's line hunks for the reader, retaining its context and line numbering. */
export function shapeRevisionDiff(version: string, replacement: string): ShapedDiff {
  const patch = structuredPatch('version', 'replacement', version, replacement, '', '', {
    context: 3,
  })
  return {
    identical: patch.hunks.length === 0,
    hunks: patch.hunks.map((hunk) => {
      let oldLine = hunk.oldStart
      let newLine = hunk.newStart
      return hunk.lines.map((line) => {
        const mark = line[0] as '+' | '-' | ' '
        const text = line.slice(1)
        if (mark === '+') return { kind: 'added' as const, mark, number: newLine++, text }
        if (mark === '-') return { kind: 'removed' as const, mark, number: oldLine++, text }
        const number = newLine++
        oldLine++
        return { kind: 'context' as const, mark: ' ' as const, number, text }
      })
    }),
  }
}
