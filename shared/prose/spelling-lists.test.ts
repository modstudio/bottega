import { describe, expect, test } from 'bun:test'
import britishSpellingsText from './british-spellings.csv' with { type: 'text' }
import misspellingsText from './misspellings.csv' with { type: 'text' }

/** The lookups binary-search the raw text, so an unsorted or duplicated key silently stops matching. */
function unorderedKeys(text: string): string[] {
  const problems: string[] = []
  let previous: string | null = null
  for (const line of text.split('\n')) {
    if (!line) continue
    const key = line.slice(0, line.indexOf(','))
    if (key !== key.toLowerCase()) problems.push(`${key} is not lowercase`)
    if (previous !== null && !(previous < key)) problems.push(`${key} follows ${previous}`)
    previous = key
  }
  return problems
}

describe('vendored spelling lists', () => {
  test.each([
    ['misspellings.csv', misspellingsText],
    ['british-spellings.csv', britishSpellingsText],
  ])('%s keys are lowercase and strictly ascending', (_name, text) => {
    expect(unorderedKeys(text).slice(0, 5)).toEqual([])
  })
})
