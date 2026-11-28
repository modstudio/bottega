import { expect, test } from 'bun:test'
import { docReadsAcrossReadableSpaces } from './doc-space-selection.ts'

for (const scope of ['global', 'project']) {
  const label = `${scope} scope`

  test(`${label}: an absent subject reads every readable space`, () => {
    expect(docReadsAcrossReadableSpaces({ scope, subject: undefined, owner: null })).toBe(true)
  })

  test(`${label}: an explicitly subjectless address reads the active space`, () => {
    expect(docReadsAcrossReadableSpaces({ scope, subject: null, owner: null })).toBe(false)
  })

  test(`${label}: a named subject reads its routed space`, () => {
    expect(docReadsAcrossReadableSpaces({ scope, subject: 'project-a', owner: null })).toBe(false)
  })

  test(`${label}: a user-owned address reads the user space`, () => {
    expect(docReadsAcrossReadableSpaces({ scope, subject: null, owner: 'user-a' })).toBe(false)
  })
}
