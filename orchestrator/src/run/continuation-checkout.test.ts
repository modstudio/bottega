import { describe, expect, test } from 'bun:test'
import { continuationCheckoutDecision } from './continuation-checkout.ts'

describe('continuation checkout decision', () => {
  test.each([
    [
      'latest recorded cwd',
      {
        latestCwd: '/projects/adanim/turn',
        rootCwd: '/projects/adanim/root',
        rootProjectPath: '/projects/adanim',
      },
      { action: 'continue', cwd: '/projects/adanim/turn', projectPath: '/projects/adanim' },
    ],
    [
      'root recorded cwd when the latest turn has none',
      { latestCwd: null, rootCwd: '/projects/adanim/root', rootProjectPath: '/projects/adanim' },
      { action: 'continue', cwd: '/projects/adanim/root', projectPath: '/projects/adanim' },
    ],
    [
      'registered project checkout when neither turn records cwd',
      { latestCwd: null, rootCwd: null, rootProjectPath: '/projects/adanim' },
      { action: 'continue', cwd: '/projects/adanim', projectPath: '/projects/adanim' },
    ],
    [
      'refusal when the root project is unavailable',
      { latestCwd: '/callers/bottega', rootCwd: '/projects/adanim/root', rootProjectPath: null },
      { action: 'refuse', reason: 'missing-repository-identity' },
    ],
  ])('%s', (_name, input, expected) => {
    expect(continuationCheckoutDecision(input)).toEqual(expected)
  })
})
