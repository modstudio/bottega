import { expect, test } from 'bun:test'
import { validateProjectSettings } from './projects.ts'

const release = {
  rungs: [],
  mergeMethod: 'squash' as const,
  requiredChecks: ['ci'],
}

test('release settings accept an optional merge-queue declaration and require a boolean', () => {
  expect(validateProjectSettings({ release: { ...release, mergeQueue: true } })).toEqual([])
  expect(
    validateProjectSettings({
      release: { ...release, mergeQueue: 'yes' },
    } as unknown as Parameters<typeof validateProjectSettings>[0]),
  ).toEqual([expect.stringContaining('release.mergeQueue: Invalid input')])
})
