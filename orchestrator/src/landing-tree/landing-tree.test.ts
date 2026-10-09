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
  test('keeps a clean existing landing tree without holding close-out', () => {
    expect(
      landingTreeHoldDecision(
        { job: LANDING_TREE_JOB, treeExists: true, branch: 'DEV-1037-orch-1', runId: 1 },
        true,
        { held: false as const },
      ),
    ).toEqual({
      held: false,
      kept: true,
      reason:
        'clean landing tree; branch DEV-1037-orch-1 holds its work; orch tree open 1 recreates it',
    })
  })

  test('holds a dirty existing landing tree', () => {
    const ordinary = { held: false as const }
    expect(
      landingTreeHoldDecision(
        { job: LANDING_TREE_JOB, treeExists: true, branch: 'DEV-1037-orch-1', runId: 1 },
        false,
        ordinary,
      ),
    ).toEqual({
      held: true,
      until: null,
      reason: 'landing tree; remove with orch tree remove <path>',
    })
  })

  test('leaves a non-landing-tree row unchanged', () => {
    const ordinary = { held: true as const, until: null, reason: 'ordinary hold' }
    expect(
      landingTreeHoldDecision(
        { job: 'implement', treeExists: true, branch: 'DEV-1037-orch-1', runId: 1 },
        true,
        ordinary,
      ),
    ).toBe(ordinary)
  })

  test('names opening refusals and their remedies', () => {
    expect(landingTreeOpeningRefusal({ branch: null })).toContain('use a finished writer run')
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
      {
        action: 'keep',
        reason:
          'landing tree held by session owner: branch has not landed; session owner releases it with orch tree remove <path>',
      },
    ],
  ] as const)('decides release from clean=%s landed=%s', (clean, landed, expected) => {
    expect(
      landingTreeReleaseDecision(
        {
          job: LANDING_TREE_JOB,
          sessionId: 'owner',
          treeExists: true,
          status: 'ok',
          landingInFlight: false,
          explicitTreeRemovalRequested: false,
        },
        clean,
        landed,
      ),
    ).toEqual(expected)
  })

  test('releases an absent terminal tree only when no landing is in flight', () => {
    const facts = {
      job: LANDING_TREE_JOB,
      sessionId: 'owner',
      treeExists: false,
      status: 'ok',
      landingInFlight: false,
      explicitTreeRemovalRequested: false,
    }
    expect(landingTreeReleaseDecision(facts, false, false)).toEqual({ action: 'release' })
    expect(landingTreeReleaseDecision({ ...facts, landingInFlight: true }, false, false)).toEqual({
      action: 'keep',
      reason: 'landing tree held by session owner: landing is in flight',
    })
    expect(landingTreeReleaseDecision({ ...facts, status: 'running' }, false, false)).toEqual({
      action: 'keep',
      reason: 'landing tree held by session owner: conversation is running',
    })
  })

  test('explicit removal releases a present clean tree before its branch lands', () => {
    const facts = {
      job: LANDING_TREE_JOB,
      sessionId: 'owner',
      treeExists: true,
      status: 'ok',
      landingInFlight: false,
      explicitTreeRemovalRequested: true,
    }
    expect(landingTreeReleaseDecision(facts, true, false)).toEqual({ action: 'release' })
    expect(landingTreeReleaseDecision(facts, false, false)).toEqual({
      action: 'keep',
      reason: 'landing tree held by session owner: tree is dirty',
    })
    expect(landingTreeReleaseDecision({ ...facts, landingInFlight: true }, true, false)).toEqual({
      action: 'keep',
      reason: 'landing tree held by session owner: landing is in flight',
    })
  })

  test('explicit removal leaves absent-tree holds unchanged', () => {
    const facts = {
      job: LANDING_TREE_JOB,
      sessionId: 'owner',
      treeExists: false,
      status: 'ok',
      landingInFlight: false,
      explicitTreeRemovalRequested: true,
    }
    expect(landingTreeReleaseDecision(facts, false, false)).toEqual({ action: 'release' })
    expect(landingTreeReleaseDecision({ ...facts, landingInFlight: true }, false, false)).toEqual({
      action: 'keep',
      reason: 'landing tree held by session owner: landing is in flight',
    })
    expect(landingTreeReleaseDecision({ ...facts, status: 'running' }, false, false)).toEqual({
      action: 'keep',
      reason: 'landing tree held by session owner: conversation is running',
    })
  })

  test('does not change ordinary or hook-tree sweep policy', () => {
    expect(
      landingTreeReleaseDecision(
        {
          job: 'hook-tree',
          sessionId: 'owner',
          treeExists: true,
          status: 'ok',
          landingInFlight: false,
          explicitTreeRemovalRequested: false,
        },
        false,
        false,
      ),
    ).toEqual({ action: 'release' })
  })
})
