import { describe, expect, test } from 'bun:test'
import { canonSlugsToRemove } from './canon-commands.ts'

describe('canonSlugsToRemove', () => {
  test('a rename removes exactly the old slug', () => {
    expect(
      canonSlugsToRemove(
        ['AGENTS.md', '.agents/rules/old-name.md'],
        ['AGENTS.md', '.agents/rules/new-name.md'],
      ),
    ).toEqual(['.agents/rules/old-name.md'])
  })

  test('an empty tree never removes current slugs', () => {
    expect(canonSlugsToRemove(['AGENTS.md', '.agents/rules/current.md'], [])).toEqual([])
  })
})
