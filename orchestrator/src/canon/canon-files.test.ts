import { expect, test } from 'bun:test'
import { isCanonPath } from './canon-files.ts'

test('workflow and skill agent content is outside the canon pack', () => {
  expect(
    [
      '.agents/workflows/ship.md',
      '.agents/workflow-steps/verify.md',
      '.agents/skills/cleanup/SKILL.md',
    ].map(isCanonPath),
  ).toEqual([false, false, false])
})
