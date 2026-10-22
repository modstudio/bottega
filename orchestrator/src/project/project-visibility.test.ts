import { expect, test } from 'bun:test'
import { assertForgeVisibility, githubForgeVisibilityLookup } from './project-visibility.ts'

test('a mismatched forge visibility is refused through the injected lookup', () => {
  const lookedUp: string[] = []
  expect(() =>
    assertForgeVisibility({
      project: 'example',
      repository: 'owner/example',
      declared: 'public',
      lookup: (repository) => {
        lookedUp.push(repository)
        return { exitCode: 0, stdout: '{"visibility":"PRIVATE"}', stderr: '' }
      },
    }),
  ).toThrow(
    'example: declared repository visibility public does not match forge visibility private for owner/example',
  )
  expect(lookedUp).toEqual(['owner/example'])
})

test('a missing gh binary becomes the ordinary remedy-carrying visibility refusal', () => {
  expect(() =>
    assertForgeVisibility({
      project: 'example',
      repository: 'owner/example',
      declared: 'public',
      lookup: (repository) =>
        githubForgeVisibilityLookup(repository, () => {
          throw new Error('Executable not found in $PATH: gh')
        }),
    }),
  ).toThrow('cleared by: restore gh access')
})
