import { expect, test } from 'bun:test'
import { RecipePrerequisiteError } from '../recipe/recipe-executable-preflight.ts'
import { startupFailureKind } from './run-startup-failure-kind.ts'

test('classifies only the typed recipe refusal as a prerequisite', () => {
  expect(
    startupFailureKind(
      new RecipePrerequisiteError('bottega', [
        { phase: 'create', step: 'root-deps', tool: 'bun' },
      ]),
    ),
  ).toBe('prerequisite')
  expect(startupFailureKind(new Error('another startup failure'))).toBe('harness')
})
