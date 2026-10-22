import { expect, test } from 'bun:test'
import { githubRepository } from '../../../shared/github-repository.ts'
import { assertForgeVisibility, githubForgeVisibilityLookup } from './project-visibility.ts'

test('a visibility declaration that mismatches the forge is refused without a network call', () => {
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

test('GitHub repository addresses share one lowercase canonical parser', () => {
  expect(githubRepository('git@github.com:Owner/Example.git')).toBe('owner/example')
  expect(githubRepository('https://github.com/Owner/Example/pull/42')).toBeNull()
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
