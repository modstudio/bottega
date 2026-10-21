import { expect, test } from 'bun:test'
import { searchMatches } from './search-select.tsx'

const options = ['Alpha', 'Beta', 'alphabet', 'Gamma'].map((label) => ({ value: label, label }))

test('matches ignore case, keep order and report what the limit left out', () => {
  expect(searchMatches(options, ' ALPHA ', 1)).toEqual({
    shown: [{ value: 'Alpha', label: 'Alpha' }],
    more: 1,
    none: false,
  })
  expect(searchMatches(options, 'zeta', 10)).toEqual({ shown: [], more: 0, none: true })
})
