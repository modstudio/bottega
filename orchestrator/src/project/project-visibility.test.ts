import { expect, test } from 'bun:test'
import { assertForgeVisibility } from './project-visibility.ts'

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
