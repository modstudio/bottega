import { describe, expect, test } from 'bun:test'
import {
  LANDING_TREE_JOB,
  landingTreeCommandBase,
  landingTreeCommandCapability,
  landingTreeHoldDecision,
  landingTreeOpeningRefusal,
  landingTreeReleaseDecision,
} from './landing-tree.ts'

describe('landing-tree decisions', () => {
  test('holds an existing landing tree and leaves an absent tree to its ordinary decision', () => {
    const ordinary = { held: false as const }
    expect(landingTreeHoldDecision({ job: LANDING_TREE_JOB, treeExists: true }, ordinary)).toEqual({
      held: true,
      until: null,
      reason: 'landing tree; remove with orch tree remove <path>',
    })
    expect(landingTreeHoldDecision({ job: LANDING_TREE_JOB, treeExists: false }, ordinary)).toBe(
      ordinary,
    )
  })

  test('names opening refusals and their remedies', () => {
    expect(landingTreeOpeningRefusal({ branch: null, seeds: [] })).toContain(
      'use a finished writer run',
    )
    expect(
      landingTreeOpeningRefusal({ branch: 'DEV-838-orch-1', seeds: ['none', 'full'] }),
    ).toContain('choose one: none, full')
  })
  test('requires command templates to accept an existing branch', () => {
    expect(landingTreeCommandCapability('scripts/tree add {branch} {base}')).toEqual({
      allowed: true,
    })
    expect(landingTreeCommandCapability('scripts/tree add {base}')).toMatchObject({
      allowed: false,
    })
    expect(
      landingTreeCommandCapability({ pipeline: 'printf %s {branch} | scripts/tree add' }),
    ).toEqual({ allowed: true })
  })

  test('uses registered trunk for command-template base', () => {
    expect(landingTreeCommandBase('develop')).toBe('develop')
    expect(() => landingTreeCommandBase(undefined)).toThrow('no registered trunk')
  })

  test.each([
    [true, true, { action: 'release' }],
    [false, true, { action: 'keep', reason: 'landing tree held by session owner: tree is dirty' }],
    [
      true,
      false,
      { action: 'keep', reason: 'landing tree held by session owner: branch has not landed' },
    ],
  ] as const)('decides release from clean=%s landed=%s', (clean, landed, expected) => {
    expect(
      landingTreeReleaseDecision({ job: LANDING_TREE_JOB, sessionId: 'owner' }, clean, landed),
    ).toEqual(expected)
  })

  test('does not change ordinary or hook-tree sweep policy', () => {
    expect(
      landingTreeReleaseDecision({ job: 'hook-tree', sessionId: 'owner' }, false, false),
    ).toEqual({ action: 'release' })
  })
})
