import { expect, test } from 'bun:test'
import { isTrialSpaceMetadata } from './record-trial-space.ts'

test('an array trial marker is not a trial space', () =>
  expect(isTrialSpaceMetadata({ trial: [] })).toBe(false))
