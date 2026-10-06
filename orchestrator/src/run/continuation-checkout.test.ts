import { describe, expect, test } from 'bun:test'
import { continuationCheckoutDecision } from './continuation-checkout.ts'

describe('continuation checkout decision', () => {
  test.each([
    [
      'latest recorded cwd',
      {
        requiresRepo: true,
        latestCwd: '/projects/adanim/turn',
        rootCwd: '/projects/adanim/root',
        rootProjectPath: '/projects/adanim',
      },
      { action: 'continue', cwd: '/projects/adanim/turn', projectPath: '/projects/adanim' },
    ],
    [
      'root recorded cwd when the latest turn has none',
      {
        requiresRepo: true,
        latestCwd: null,
        rootCwd: '/projects/adanim/root',
        rootProjectPath: '/projects/adanim',
      },
      { action: 'continue', cwd: '/projects/adanim/root', projectPath: '/projects/adanim' },
    ],
    [
      'registered project checkout when neither turn records cwd',
      {
        requiresRepo: true,
        latestCwd: null,
        rootCwd: null,
        rootProjectPath: '/projects/adanim',
      },
      { action: 'continue', cwd: '/projects/adanim', projectPath: '/projects/adanim' },
    ],
    [
      'refusal when the root project is unavailable',
      {
        requiresRepo: true,
        latestCwd: '/callers/other',
        rootCwd: '/projects/adanim/root',
        rootProjectPath: null,
      },
      { action: 'refuse', reason: 'missing-repository-identity' },
    ],
    [
      'repository-free job uses its recorded cwd without a project',
      {
        requiresRepo: false,
        latestCwd: null,
        rootCwd: '/recorded/summary',
        rootProjectPath: null,
      },
      { action: 'continue', cwd: '/recorded/summary', projectPath: null },
    ],
    [
      'repository-free job refuses when its chain records no cwd',
      { requiresRepo: false, latestCwd: null, rootCwd: null, rootProjectPath: null },
      { action: 'refuse', reason: 'missing-recorded-cwd' },
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(continuationCheckoutDecision(input)).toEqual(expected)
  })
})
